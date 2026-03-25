# Deploying the Bounty Board Contract

## Prerequisites

1. Install the Sui CLI: https://docs.sui.io/guides/developer/getting-started/sui-install
2. Make sure you have a Sui wallet with testnet SUI

## Steps

### 1. Switch to testnet
```bash
sui client switch --env testnet
```

### 2. Get your active address
```bash
sui client active-address
```

### 3. Get testnet SUI (if needed)
```bash
sui client faucet
```

### 4. Build the contract
```bash
cd contracts/bounty_board
sui move build
```

### 5. Deploy the contract
```bash
sui client publish --gas-budget 100000000
```

### 6. Copy the Package ID
From the output, find the line that says `Published Objects` and copy the **Package ID**.

It will look something like:
```
Published Objects:
  PackageID: 0xabc123...
```

### 7. Update the frontend
Open `src/App.jsx` and replace `YOUR_PACKAGE_ID_HERE` with your Package ID:

```js
const BOUNTY_PKG = '0xabc123...'  // your actual package ID
```

### 8. Run the frontend
```bash
npm run dev
```

## Contract Functions

| Function | Who Can Call | What It Does |
|----------|-------------|-------------|
| `post_bounty` | Anyone | Escrows SUI in a new Bounty object |
| `claim_bounty` | Anyone | Claims the bounty, SUI goes to caller |
| `cancel_bounty` | Poster only | Refunds SUI after bounty expires |

## How It Works

1. **Post**: User sends SUI which gets locked in a shared Bounty object on-chain
2. **Claim**: When a kill is detected in EVE Frontier, the hunter calls `claim_bounty` and receives the escrowed SUI
3. **Cancel**: If nobody claims before expiry, the poster can get their SUI back
