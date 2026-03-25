module bounty_board::bounty_board {
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use std::string::String;
    use sui::event;

    // ── Error codes ──────────────────────────────────────────────
    const E_ZERO_AMOUNT: u64 = 0;
    const E_INVALID_EXPIRY: u64 = 1;
    const E_ALREADY_CLAIMED: u64 = 2;
    const E_NOT_POSTER: u64 = 3;
    const E_NOT_EXPIRED: u64 = 4;

    // ── Events ─────────────────────────────────────────────────────
    public struct BountyPosted has copy, drop {
        bounty_id: ID,
        poster: address,
        amount_mist: u64,
    }

    public struct BountyClaimed has copy, drop {
        bounty_id: ID,
        hunter: address,
        hunter_name: String,
        amount_mist: u64,
    }

    public struct BountyCancelled has copy, drop {
        bounty_id: ID,
        poster: address,
        refund_mist: u64,
    }

    // ── Bounty object (shared) ───────────────────────────────────
    public struct Bounty has key {
        id: UID,
        target_name: String,
        poster: address,
        poster_name: String,
        reason: String,
        balance: Balance<SUI>,
        posted_at_ms: u64,
        expires_at_ms: u64,
        claimed: bool,
        claimed_by: address,
        killer_name: String,
    }

    // ── Post a bounty ────────────────────────────────────────────
    public entry fun post_bounty(
        target_name: String,
        poster_name: String,
        reason: String,
        payment: Coin<SUI>,
        expiry_days: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let amount = coin::value(&payment);
        assert!(amount > 0, E_ZERO_AMOUNT);
        assert!(expiry_days > 0 && expiry_days <= 30, E_INVALID_EXPIRY);

        let now = clock::timestamp_ms(clock);
        let uid = object::new(ctx);
        let bounty_id = object::uid_to_inner(&uid);

        event::emit(BountyPosted {
            bounty_id,
            poster: tx_context::sender(ctx),
            amount_mist: amount,
        });

        let bounty = Bounty {
            id: uid,
            target_name,
            poster: tx_context::sender(ctx),
            poster_name,
            reason,
            balance: coin::into_balance(payment),
            posted_at_ms: now,
            expires_at_ms: now + (expiry_days * 86_400_000),
            claimed: false,
            claimed_by: @0x0,
            killer_name: std::string::utf8(b""),
        };

        transfer::share_object(bounty);
    }

    // ── Claim a bounty ───────────────────────────────────────────
    // The frontend verifies the claimer's EVE identity via their
    // on-chain PlayerProfile → Character → metadata.name.
    // killer_name is passed from the killmail data for record-keeping.
    public entry fun claim_bounty(
        bounty: &mut Bounty,
        killer_name: String,
        ctx: &mut TxContext,
    ) {
        assert!(!bounty.claimed, E_ALREADY_CLAIMED);

        let hunter = tx_context::sender(ctx);

        bounty.claimed = true;
        bounty.claimed_by = hunter;
        bounty.killer_name = killer_name;

        let amount = balance::value(&bounty.balance);
        let withdrawn = balance::split(&mut bounty.balance, amount);
        let payment = coin::from_balance(withdrawn, ctx);
        transfer::public_transfer(payment, hunter);

        event::emit(BountyClaimed {
            bounty_id: object::uid_to_inner(&bounty.id),
            hunter,
            hunter_name: killer_name,
            amount_mist: amount,
        });
    }

    // ── Cancel an expired bounty ─────────────────────────────────
    public entry fun cancel_bounty(
        bounty: &mut Bounty,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(!bounty.claimed, E_ALREADY_CLAIMED);
        assert!(tx_context::sender(ctx) == bounty.poster, E_NOT_POSTER);
        assert!(clock::timestamp_ms(clock) >= bounty.expires_at_ms, E_NOT_EXPIRED);

        bounty.claimed = true;

        let amount = balance::value(&bounty.balance);
        let withdrawn = balance::split(&mut bounty.balance, amount);
        let payment = coin::from_balance(withdrawn, ctx);
        transfer::public_transfer(payment, bounty.poster);

        event::emit(BountyCancelled {
            bounty_id: object::uid_to_inner(&bounty.id),
            poster: bounty.poster,
            refund_mist: amount,
        });
    }
}
