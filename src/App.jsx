import { useState, useEffect, useCallback } from 'react'
import { Transaction } from '@mysten/sui/transactions'
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc'
import './App.css'

// ── Config ───────────────────────────────────────────────────────
const SUI_RPC = 'https://fullnode.testnet.sui.io:443'
const SUI_GRAPHQL = 'https://graphql.testnet.sui.io/graphql'
const WORLD_PKG = '0x28b497559d65ab320d9da4613bf2498d5946b2c0ae3597ccfda3072ce127448c'

// ★ REPLACE after deploying the contract
const BOUNTY_PKG = '0x5719bc5cf147e5404ff7782c3c300e5c35272b35be92f397cc2720c1bf9a723e'

const BOUNTY_TYPE = `${BOUNTY_PKG}::bounty_board::Bounty`
const CLOCK_ID = '0x0000000000000000000000000000000000000000000000000000000000000006'

// EVE Frontier character types for vault lookup
const PLAYER_PROFILE_TYPE = `${WORLD_PKG}::character::PlayerProfile`

const suiClient = new SuiJsonRpcClient({ url: SUI_RPC })

// ── GraphQL helper ───────────────────────────────────────────────
async function gql(query) {
  try {
    const res = await fetch(SUI_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    })
    const d = await res.json()
    if (d.errors?.length) throw new Error(d.errors[0].message)
    return d.data
  } catch (e) {
    console.error('GraphQL error:', e)
    return null
  }
}

// Fetch all objects of a type via GraphQL pagination
async function fetchAllObjects(type, maxItems = 5000) {
  const results = []
  let after = null
  let hasNext = true
  while (hasNext && results.length < maxItems) {
    const afterClause = after ? `, after: "${after}"` : ''
    const data = await gql(`{
      objects(filter: { type: "${type}" }, first: 50${afterClause}) {
        pageInfo { hasNextPage endCursor }
        nodes { address asMoveObject { contents { json } } }
      }
    }`)
    if (!data) break
    const objs = data.objects
    results.push(...objs.nodes.map(n => ({
      objectId: n.address,
      ...n.asMoveObject.contents.json
    })))
    hasNext = objs.pageInfo.hasNextPage
    after = objs.pageInfo.endCursor
  }
  return results
}

// ── EVE Vault Lookup ─────────────────────────────────────────────
// Look up a player's EVE Frontier character from their wallet address
// Tries multiple methods:
// 1. PlayerProfile owned by wallet → Character → metadata.name
// 2. Scan all Character objects for matching character_address
async function lookupEveCharacter(walletAddress) {
  try {
    // Method 1: Look for PlayerProfile owned by this wallet (JSON-RPC)
    console.log('EVE Vault: Looking up PlayerProfile for', walletAddress)
    try {
      const owned = await suiClient.getOwnedObjects({
        owner: walletAddress,
        filter: { StructType: PLAYER_PROFILE_TYPE },
        options: { showContent: true },
      })
      console.log('EVE Vault: PlayerProfile result:', JSON.stringify(owned, null, 2))

      if (owned?.data?.length > 0) {
        const fullObj = owned.data[0]
        console.log('EVE Vault: Full profile object:', JSON.stringify(fullObj, null, 2))
        const profileContent = fullObj.data?.content
        console.log('EVE Vault: Profile content:', JSON.stringify(profileContent, null, 2))
        const fields = profileContent?.fields || profileContent?.json
        console.log('EVE Vault: Profile fields:', JSON.stringify(fields, null, 2))
        const characterId = fields?.character_id

        if (characterId) {
          console.log('EVE Vault: Found character_id:', characterId)
          const charObj = await suiClient.getObject({
            id: characterId,
            options: { showContent: true },
          })

          if (charObj?.data?.content) {
            const charFields = charObj.data.content.fields || charObj.data.content.json
            const name = charFields?.metadata?.fields?.name || charFields?.metadata?.name
            return {
              name: name?.trim() || null,
              characterId,
              characterAddress: charFields?.character_address,
              tribeId: charFields?.tribe_id,
              tenant: charFields?.key?.fields?.tenant || charFields?.key?.tenant,
              itemId: charFields?.key?.fields?.item_id || charFields?.key?.item_id,
            }
          }
        }
      }
    } catch (e) {
      console.log('EVE Vault: PlayerProfile lookup failed, trying fallback:', e)
    }

    // Method 2: Scan all Character objects and match by character_address
    console.log('EVE Vault: Trying character_address scan fallback...')
    const charObjects = await fetchAllObjects(`${WORLD_PKG}::character::Character`)
    for (const c of charObjects) {
      if (c.character_address === walletAddress) {
        const name = c.metadata?.name?.trim()
        console.log('EVE Vault: Found character via address scan:', name)
        return {
          name: name || null,
          characterId: c.objectId,
          characterAddress: c.character_address,
          tribeId: c.tribe_id,
          tenant: c.key?.tenant,
          itemId: c.key?.item_id,
        }
      }
    }

    console.log('EVE Vault: No character found for this wallet')
    return null
  } catch (e) {
    console.error('EVE Vault lookup failed:', e)
    return null
  }
}

// ── Time-ago helper ──────────────────────────────────────────────
function timeAgo(t) {
  const d = Date.now() - new Date(t).getTime()
  if (d < 60000) return 'just now'
  if (d < 3600000) return Math.floor(d / 60000) + 'm ago'
  if (d < 86400000) return Math.floor(d / 3600000) + 'h ago'
  return Math.floor(d / 86400000) + 'd ago'
}

// ── Wallet detection (wallet-standard) ───────────────────────────
function getSuiWallets() {
  const wallets = []
  if (typeof window !== 'undefined') {
    const event = new CustomEvent('wallet-standard:app-ready', {
      detail: { register: (wallet) => wallets.push(wallet) }
    })
    window.dispatchEvent(event)
  }
  return wallets.filter(w => w.chains && w.chains.some(c => c.startsWith('sui:')))
}

// ── Sign & execute a Transaction via wallet-standard ─────────────
async function execTx(wallet, account, tx) {
  if (wallet.features['sui:signAndExecuteTransaction']) {
    return await wallet.features['sui:signAndExecuteTransaction'].signAndExecuteTransaction({
      transaction: tx,
      account,
      chain: 'sui:testnet',
    })
  }
  if (wallet.features['sui:signAndExecuteTransactionBlock']) {
    return await wallet.features['sui:signAndExecuteTransactionBlock'].signAndExecuteTransactionBlock({
      transactionBlock: tx,
      account,
      chain: 'sui:testnet',
    })
  }
  throw new Error('Wallet does not support transaction signing')
}

// ══════════════════════════════════════════════════════════════════
function App() {
  // Wallet
  const [wallet, setWallet] = useState(null)
  const [account, setAccount] = useState(null)
  const [balance, setBalance] = useState('0.00')
  const [wallets, setWallets] = useState([])
  const [showWalletPicker, setShowWalletPicker] = useState(false)

  // EVE Vault identity (auto-detected or manual fallback)
  const [eveCharacter, setEveCharacter] = useState(null)
  const [vaultLoading, setVaultLoading] = useState(false)
  const [vaultStatus, setVaultStatus] = useState('')
  const [manualName, setManualName] = useState('')
  const [manualNameSet, setManualNameSet] = useState(false)

  // Kill data (from EVE world)
  const [kills, setKills] = useState([])
  const [charMap, setCharMap] = useState({})
  const [loading, setLoading] = useState(true)

  // Bounties (from chain)
  const [bounties, setBounties] = useState([])
  const [claimedBounties, setClaimedBounties] = useState([])
  const [bountiesLoading, setBountiesLoading] = useState(false)

  // Form
  const [targetName, setTargetName] = useState('')
  const [posterName, setPosterName] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [expiry, setExpiry] = useState(7)
  const [formMsg, setFormMsg] = useState('')

  // Claimed history
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('eve_bounty_v2_claimed'))
      if (stored) setClaimedBounties(stored)
    } catch {}
  }, [])

  const saveClaimedHistory = useCallback((list) => {
    try { localStorage.setItem('eve_bounty_v2_claimed', JSON.stringify(list)) } catch {}
  }, [])

  // ── Detect wallets ───────────────────────────────────────────
  useEffect(() => {
    const detected = getSuiWallets()
    setWallets(detected)
    setTimeout(() => {
      const retry = getSuiWallets()
      if (retry.length > detected.length) setWallets(retry)
    }, 1500)
  }, [])

  // ── Fetch balance ────────────────────────────────────────────
  async function fetchBalance(addr) {
    try {
      const result = await suiClient.getBalance({ owner: addr, coinType: '0x2::sui::SUI' })
      return (parseInt(result.totalBalance) / 1e9).toFixed(4)
    } catch { return '0.0000' }
  }

  // ── Connect wallet + auto-detect EVE identity ────────────────
  async function connectWallet(w) {
    try {
      const connectFeature = w.features['standard:connect']
      const result = await connectFeature.connect()
      const acc = result.accounts[0]
      setWallet(w)
      setAccount(acc)
      setShowWalletPicker(false)
      const bal = await fetchBalance(acc.address)
      setBalance(bal)

      // Auto-detect EVE Frontier identity via vault
      setVaultLoading(true)
      setVaultStatus('Looking up your EVE Frontier identity...')
      const character = await lookupEveCharacter(acc.address)
      if (character && character.name) {
        setEveCharacter(character)
        setPosterName(character.name)
        setVaultStatus('')
      } else {
        setEveCharacter(null)
        setVaultStatus('No EVE Frontier character found for this wallet. You can still post bounties but cannot claim them.')
      }
      setVaultLoading(false)
    } catch (e) {
      console.error('Connect failed:', e)
      setFormMsg('Failed to connect wallet')
    }
  }

  function disconnect() {
    setWallet(null)
    setAccount(null)
    setBalance('0.00')
    setEveCharacter(null)
    setVaultStatus('')
    setPosterName('')
  }

  // ── Load bounties from chain ─────────────────────────────────
  const loadBounties = useCallback(async () => {
    if (BOUNTY_PKG === 'YOUR_PACKAGE_ID_HERE') return
    setBountiesLoading(true)
    try {
      const objects = await fetchAllObjects(BOUNTY_TYPE)
      const parsed = objects.map(b => {
        const balValue = typeof b.balance === 'object' ? b.balance.value : b.balance
        return {
          id: b.objectId,
          target: b.target_name,
          poster: b.poster,
          posterName: b.poster_name,
          reason: b.reason,
          amount: (parseInt(balValue || '0') / 1e9).toFixed(4),
          amountMist: parseInt(balValue || '0'),
          posted: new Date(parseInt(b.posted_at_ms)).toISOString(),
          expiry: new Date(parseInt(b.expires_at_ms)).toISOString(),
          claimed: b.claimed,
          claimedBy: b.claimed_by,
          killerName: b.killer_name,
        }
      })

      const active = parsed.filter(b => !b.claimed)
      const onChainClaimed = parsed.filter(b => b.claimed && b.claimedBy !== '0x0000000000000000000000000000000000000000000000000000000000000000')

      setBounties(active)

      if (onChainClaimed.length > 0) {
        setClaimedBounties(prev => {
          const ids = new Set(prev.map(c => c.id))
          const merged = [...prev]
          for (const c of onChainClaimed) {
            if (!ids.has(c.id)) merged.unshift(c)
          }
          saveClaimedHistory(merged)
          return merged
        })
      }
    } catch (e) {
      console.error('Failed to load bounties:', e)
    }
    setBountiesLoading(false)
  }, [saveClaimedHistory])

  useEffect(() => { loadBounties() }, [loadBounties])

  // ── Load kill data (EVE world) ───────────────────────────────
  useEffect(() => {
    async function loadData() {
      setLoading(true)
      try {
        const [killObjects, charObjects] = await Promise.all([
          fetchAllObjects(`${WORLD_PKG}::killmail::Killmail`),
          fetchAllObjects(`${WORLD_PKG}::character::Character`)
        ])

        const cMap = {}
        for (const c of charObjects) {
          const id = c.key?.item_id
          const name = c.metadata?.name?.trim()
          if (id && name) cMap[id] = name
        }
        setCharMap(cMap)

        const killList = killObjects.map(k => {
          const killerId = k.killer_id?.item_id || ''
          const victimId = k.victim_id?.item_id || ''
          const lossType = k.loss_type?.['@variant'] || k.loss_type?.variant || 'UNKNOWN'
          return {
            id: k.key?.item_id || k.objectId,
            killer: cMap[killerId] || 'Char#' + killerId,
            killerId,
            victim: cMap[victimId] || 'Char#' + victimId,
            victimId,
            system: k.solar_system_id?.item_id || '',
            lossType,
            time: new Date(parseInt(k.kill_timestamp) * 1000).toISOString(),
            objectId: k.objectId
          }
        }).sort((a, b) => new Date(b.time) - new Date(a.time))

        setKills(killList)
      } catch (e) {
        console.error('Load failed:', e)
      }
      setLoading(false)
    }
    loadData()
  }, [])

  // ── Match kills to bounties ────────────────────────────────────
  const claimableMap = {}
  for (const b of bounties) {
    for (const k of kills) {
      if (k.victim.toLowerCase() === b.target.toLowerCase() &&
          k.lossType === 'SHIP' &&
          new Date(k.time) > new Date(b.posted)) {
        claimableMap[b.id] = k
        break
      }
    }
  }

  // ── Post bounty (on-chain) ───────────────────────────────────
  async function postBounty() {
    if (!account) { setFormMsg('Connect your wallet first'); return }
    if (!targetName.trim()) { setFormMsg('Enter a target player name'); return }
    if (!posterName.trim()) { setFormMsg('Enter your in-game name'); return }
    const amt = parseFloat(amount)
    if (!amt || amt < 0.001) { setFormMsg('Minimum bounty: 0.001 SUI'); return }

    if (BOUNTY_PKG === 'YOUR_PACKAGE_ID_HERE') {
      setFormMsg('Contract not deployed yet!')
      return
    }

    setFormMsg('Building transaction...')
    try {
      const amtMist = Math.floor(amt * 1e9)
      const tx = new Transaction()
      const [coin] = tx.splitCoins(tx.gas, [amtMist])

      tx.moveCall({
        target: `${BOUNTY_PKG}::bounty_board::post_bounty`,
        arguments: [
          tx.pure.string(targetName.trim()),
          tx.pure.string(posterName.trim()),
          tx.pure.string(reason || ''),
          coin,
          tx.pure.u64(expiry),
          tx.object(CLOCK_ID),
        ],
      })

      setFormMsg('Approve the transaction in your wallet...')
      const result = await execTx(wallet, account, tx)
      const digest = result.digest || result.txDigest || ''

      setFormMsg('Bounty posted on-chain! TX: ' + digest.slice(0, 12) + '...')
      setTargetName('')
      setAmount('')
      setReason('')

      setTimeout(loadBounties, 2000)
      const bal = await fetchBalance(account.address)
      setBalance(bal)
    } catch (e) {
      if (e.message?.includes('rejected') || e.message?.includes('Rejected')) {
        setFormMsg('Transaction rejected by user.')
      } else {
        setFormMsg('Error: ' + e.message)
      }
    }
  }

  // ── Claim bounty (on-chain) ──────────────────────────────────
  async function claimBounty(bounty, killerName) {
    if (!account) { setFormMsg('Connect your wallet to claim'); return }
    if (!eveCharacter) { setFormMsg('No EVE Frontier character detected for your wallet'); return }

    try {
      setFormMsg('Claiming bounty...')
      const tx = new Transaction()
      tx.moveCall({
        target: `${BOUNTY_PKG}::bounty_board::claim_bounty`,
        arguments: [
          tx.object(bounty.id),
          tx.pure.string(killerName),
        ],
      })

      const result = await execTx(wallet, account, tx)
      const digest = result.digest || result.txDigest || ''

      const claimRecord = {
        ...bounty,
        claimed: true,
        claimedBy: account.address,
        claimedByName: killerName,
        claimedAt: new Date().toISOString(),
        txDigest: digest,
      }
      const newClaimed = [claimRecord, ...claimedBounties]
      setClaimedBounties(newClaimed)
      saveClaimedHistory(newClaimed)

      setFormMsg('Bounty claimed! +' + bounty.amount + ' SUI. TX: ' + digest.slice(0, 12) + '...')

      setTimeout(loadBounties, 2000)
      const bal = await fetchBalance(account.address)
      setBalance(bal)
    } catch (e) {
      if (e.message?.includes('rejected') || e.message?.includes('Rejected')) {
        setFormMsg('Transaction rejected.')
      } else {
        setFormMsg('Claim error: ' + e.message)
      }
    }
  }

  // ── Cancel expired bounty (on-chain) ─────────────────────────
  async function cancelBounty(bounty) {
    if (!account) { setFormMsg('Connect your wallet first'); return }

    try {
      setFormMsg('Cancelling bounty...')
      const tx = new Transaction()
      tx.moveCall({
        target: `${BOUNTY_PKG}::bounty_board::cancel_bounty`,
        arguments: [tx.object(bounty.id), tx.object(CLOCK_ID)],
      })

      const result = await execTx(wallet, account, tx)
      const digest = result.digest || result.txDigest || ''
      setFormMsg('Bounty cancelled, SUI refunded! TX: ' + digest.slice(0, 12) + '...')

      setTimeout(loadBounties, 2000)
      const bal = await fetchBalance(account.address)
      setBalance(bal)
    } catch (e) {
      if (e.message?.includes('rejected') || e.message?.includes('Rejected')) {
        setFormMsg('Transaction rejected.')
      } else if (e.message?.includes('4')) {
        setFormMsg('Bounty has not expired yet.')
      } else {
        setFormMsg('Cancel error: ' + e.message)
      }
    }
  }

  // ── Derived state ────────────────────────────────────────────
  const pool = bounties.reduce((s, b) => s + parseFloat(b.amount), 0)

  const hunterStats = {}
  for (const b of claimedBounties) {
    const h = b.claimedByName || b.claimedBy?.slice(0, 8) || 'Unknown'
    if (!hunterStats[h]) hunterStats[h] = { claims: 0, earned: 0 }
    hunterStats[h].claims++
    hunterStats[h].earned += parseFloat(b.amount) || 0
  }
  const hunterList = Object.entries(hunterStats).sort((a, b) => b[1].claims - a[1].claims).slice(0, 10)

  const contractReady = BOUNTY_PKG !== 'YOUR_PACKAGE_ID_HERE'

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className="app">
      <div className="topbar">
        <h1>EVE <b>FRONTIER</b></h1>
        <div className="live">BOUNTY BOARD V2 — EVE Vault — Sui Testnet</div>
      </div>

      <div className="hero">
        <h2>BOUNTY <b>BOARD</b> <span style={{fontSize:'14px', color:'#ffaa00'}}>V2 — EVE VAULT</span></h2>
        <p>Post on-chain bounties backed by real SUI. Your EVE Frontier identity is automatically detected from your wallet's EVE Vault — no registration needed. When the target dies, only the verified killer can claim.</p>
      </div>

      <div className="wrap">
        {!contractReady && (
          <div className="contract-banner">
            Contract not deployed yet. Set <code>BOUNTY_PKG</code> in App.jsx after running <code>sui client publish</code>.
          </div>
        )}

        {/* Wallet */}
        <div className="wallet-bar">
          {!account ? (
            <div>
              <button className="btn btn-connect" onClick={() => {
                const w = getSuiWallets()
                setWallets(w)
                if (w.length === 1) connectWallet(w[0])
                else if (w.length > 1) setShowWalletPicker(true)
                else setFormMsg('No Sui wallet found. Install Sui Wallet or Slush.')
              }}>
                CONNECT SUI WALLET
              </button>
              {showWalletPicker && (
                <div className="wallet-picker">
                  {wallets.map((w, i) => (
                    <button key={i} className="btn btn-wallet" onClick={() => connectWallet(w)}>
                      {w.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="wallet-connected">
              <span className="wallet-dot"></span>
              <span className="wallet-addr">{account.address.slice(0, 8)}...{account.address.slice(-6)}</span>
              <span className="wallet-bal">{balance} SUI</span>
              <span className="chain-badge">SUI TESTNET</span>
              <button className="btn btn-sm" onClick={disconnect}>DISCONNECT</button>
            </div>
          )}
        </div>

        {/* EVE Vault Identity */}
        {account && (
          <div className="register-bar">
            {vaultLoading ? (
              <div className="register-title" style={{color: '#4da2ff'}}>Detecting EVE Frontier identity from your wallet...</div>
            ) : eveCharacter ? (
              <div style={{display:'flex', alignItems:'center', gap:'12px', flexWrap:'wrap'}}>
                <div>
                  <div className="registered-label">EVE VAULT IDENTITY DETECTED</div>
                  <div className="registered-name" style={{fontSize:'18px'}}>{eveCharacter.name}</div>
                </div>
                <span className="chain-badge" style={{background:'#00ff8820', color:'#00ff88', fontSize:'10px'}}>VERIFIED VIA EVE VAULT</span>
                {eveCharacter.tenant && <span className="chain-badge">{eveCharacter.tenant.toUpperCase()}</span>}
                {eveCharacter.tribeId && <span className="dim">Tribe #{eveCharacter.tribeId}</span>}
              </div>
            ) : (
              <div>
                <div className="register-title" style={{color: '#3a5070'}}>NO EVE FRONTIER CHARACTER DETECTED</div>
                <div className="dim" style={{fontSize:'12px'}}>
                  Connect with your EVE Vault wallet to auto-detect your character. You can still post bounties.
                </div>
              </div>
            )}
          </div>
        )}

        {/* Bounty Pool */}
        <div className="bounty-total">
          <div className="pool-label">Total Bounty Pool (Escrowed On-Chain)</div>
          <div className="pool-amount">{pool.toFixed(4)} SUI</div>
          <div className="pool-sub">
            {bounties.length} active bounties · {claimedBounties.length} claimed
            {bountiesLoading && ' · loading...'}
          </div>
        </div>

        <div className="two-col">
          {/* Left: Form */}
          <div>
            <div className="sec-title">Post a Bounty</div>
            <div className="form-box">
              <label>TARGET PLAYER NAME</label>
              <input value={targetName} onChange={e => setTargetName(e.target.value)} placeholder="Type the player's in-game name..." />

              <label>YOUR IN-GAME NAME {eveCharacter && <span style={{color:'#00ff88', fontSize:'9px', letterSpacing:'1px'}}>(AUTO-DETECTED)</span>}</label>
              <input
                value={posterName}
                onChange={e => setPosterName(e.target.value)}
                placeholder="Type your in-game name..."
                readOnly={!!eveCharacter}
                style={eveCharacter ? {borderColor: '#00ff8840', color: '#00ff88'} : {}}
              />
              {eveCharacter && <div className="hint" style={{color: '#00ff88'}}>Auto-filled from your EVE Vault</div>}

              <label>BOUNTY AMOUNT (SUI)</label>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.1" min="0.001" step="0.001" />
              <div className="hint">Min: 0.001 SUI · Escrowed in smart contract until claimed or expired</div>

              <label>REASON (optional)</label>
              <input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Ganked me in E8Q-5BG..." />

              <label>EXPIRES</label>
              <div className="expiry-opts">
                {[1, 3, 7, 30].map(d => (
                  <span key={d} className={`exp-opt ${expiry === d ? 'on' : ''}`} onClick={() => setExpiry(d)}>
                    {d === 1 ? '24h' : d + ' days'}
                  </span>
                ))}
              </div>

              <button className="btn btn-primary full" onClick={postBounty} disabled={!contractReady}>
                {contractReady ? 'ESCROW SUI & POST BOUNTY' : 'CONTRACT NOT DEPLOYED'}
              </button>
              {formMsg && <div className="form-msg">{formMsg}</div>}

              <div className="how-it-works">
                <b>How it works (V2 — EVE Vault):</b> Your SUI is locked in a smart contract on Sui Testnet.
                When the target is killed on-chain (EVE Frontier), the hunter can claim
                the bounty — identity is verified via the EVE Vault (PlayerProfile → Character → name).
                No manual registration needed. If nobody claims before expiry, you can cancel and get your SUI back.
              </div>
            </div>
          </div>

          {/* Right: Active & Claimed */}
          <div>
            <div className="sec-title">Active Bounties {bounties.length > 0 && <span className="onchain-badge">ON-CHAIN</span>}</div>
            {bounties.length === 0 ? (
              <div className="empty-state">
                {bountiesLoading ? 'Loading bounties from Sui...' : 'No active bounties yet. Be the first to post one.'}
              </div>
            ) : (
              bounties.map(b => {
                const daysLeft = Math.max(0, Math.ceil((new Date(b.expiry) - Date.now()) / 86400000))
                const isExpired = daysLeft === 0
                const matchedKill = claimableMap[b.id]
                const isPoster = account && b.poster === account.address
                const isKiller = matchedKill && eveCharacter && matchedKill.killer.toLowerCase() === eveCharacter.name.toLowerCase()
                return (
                  <div key={b.id} className={`bounty-card ${matchedKill ? 'bounty-claimable' : ''}`}>
                    <div className="bounty-header">
                      <div>
                        <div className="bounty-target">{b.target}</div>
                      </div>
                      <div className="bounty-amount">{b.amount} <span className="sui-label">SUI</span></div>
                    </div>
                    {b.reason && <div className="bounty-reason">"{b.reason}"</div>}

                    {/* Kill detected */}
                    {matchedKill && (
                      <div className="claim-section">
                        <div className="claim-match">
                          Kill detected: <b className="orange">{matchedKill.killer}</b> destroyed <b className="red">{matchedKill.victim}</b>
                        </div>
                        {isKiller ? (
                          <button className="btn btn-claim" onClick={() => claimBounty(b, matchedKill.killer)}>
                            CLAIM {b.amount} SUI (VERIFIED VIA EVE VAULT)
                          </button>
                        ) : (
                          <div className="dim" style={{padding: '6px 0'}}>
                            Only <b className="orange">{matchedKill.killer}</b> can claim this bounty (verified via EVE Vault)
                          </div>
                        )}
                      </div>
                    )}

                    <div className="bounty-footer">
                      <div>
                        <span className="status active">ACTIVE</span>
                        <span className="dim ml">{isExpired ? 'EXPIRED' : daysLeft + 'd left'}</span>
                        <span className="badge funded" onClick={() => window.open(`https://testnet.suivision.xyz/object/${b.id}`, '_blank')}>ON-CHAIN</span>
                      </div>
                      <div className="dim">
                        {b.posterName ? <span className="poster-name">by {b.posterName}</span> : `by ${b.poster.slice(0, 8)}...`}
                        {isPoster && isExpired && (
                          <button className="btn btn-cancel" onClick={() => cancelBounty(b)}>CANCEL & REFUND</button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}

            <div className="sec-title mt">Recently Claimed</div>
            {claimedBounties.length === 0 ? (
              <div className="empty-state">No bounties claimed yet.</div>
            ) : (
              claimedBounties.map((b, i) => (
                <div key={i} className="bounty-card claimed-card">
                  <div className="bounty-header">
                    <span className="status claimed-status">CLAIMED</span>
                    <span className="claimed-amount">+{b.amount} SUI</span>
                  </div>
                  <div className="claimed-info">
                    <b className="orange">{b.claimedByName || b.claimedBy?.slice(0, 10) + '...'}</b> killed <b className="red">{b.target}</b>
                  </div>
                  <div className="dim">
                    {b.claimedAt ? timeAgo(b.claimedAt) : ''}
                    {b.txDigest && (
                      <span className="badge funded ml" onClick={() => window.open(`https://testnet.suivision.xyz/txblock/${b.txDigest}`, '_blank')}>VIEW TX</span>
                    )}
                  </div>
                </div>
              ))
            )}

            <div className="sec-title mt">Top Bounty Hunters</div>
            {hunterList.length === 0 ? (
              <div className="empty-state">No bounties claimed yet.</div>
            ) : (
              hunterList.map(([name, stats], i) => (
                <div key={name} className="lb-row">
                  <span className={`rank ${i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : ''}`}>#{i + 1}</span>
                  <span className="lb-name">{name}</span>
                  <span className="lb-val">{stats.claims} claims · {stats.earned.toFixed(4)} SUI</span>
                </div>
              ))
            )}

            {/* Kill Feed */}
            <div className="sec-title mt">Recent Kills (Last 24h — On-Chain)</div>
            {loading ? (
              <div className="empty-state">Loading kills from Sui...</div>
            ) : kills.filter(k => Date.now() - new Date(k.time).getTime() < 86400000).length === 0 ? (
              <div className="empty-state">No kills in the last 24 hours.</div>
            ) : (
              <div className="kill-feed">
                {kills.filter(k => Date.now() - new Date(k.time).getTime() < 86400000).sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 20).map((k, i) => (
                  <div key={i} className="kill-item">
                    <div className="kill-icon">💀</div>
                    <div className="kill-text">
                      <b className="orange">{k.killer}</b> <span className="dim">destroyed</span> <b className="red">{k.victim}</b>
                      <br /><span className="dim">System {k.system} · {k.lossType}</span>
                    </div>
                    <div className="dim">{timeAgo(k.time)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
