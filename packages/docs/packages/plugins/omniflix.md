# @elizaos/plugin-omniflix

A plugin for ElizaOS that enables interaction with the OmniFlix Network blockchain.

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Features](#features)
- [Integration](#integration)
- [Technical Details](#technical-details)

## Installation

```bash
npm install @elizaos/plugin-omniflix
```

## Configuration

### Environment Variables

```env
# Required: RPC endpoint for OmniFlix Network
OMNIFLIX_RPC_ENDPOINT="https://rpc.omniflix.network:443"

# Required: API endpoint for OmniFlix Network
OMNIFLIX_API_URL="https://rest.omniflix.network"

# Required: Either mnemonic or private key (one is required)
OMNIFLIX_MNEMONIC="your mnemonic"
# OR
OMNIFLIX_PRIVATE_KEY="your hex private key"
```

### Network Configuration

You can configure different networks by updating the endpoints:

#### Mainnet (Default)

```env
OMNIFLIX_RPC_ENDPOINT="https://rpc.omniflix.network"
OMNIFLIX_API_URL="https://rest.omniflix.network"
```

#### Testnet

```env
OMNIFLIX_RPC_ENDPOINT="https://rpc.testnet.omniflix.network"
OMNIFLIX_API_URL="https://api.testnet.omniflix.network"
```

Note: Make sure to use the appropriate network endpoints based on your requirements. The mainnet endpoints should be used for production environments, while testnet are suitable for testing.

## Features

### 1. Bank Operations

#### Check Balance

```
Commands:
- What is my balance?
- How many FLIX do I have?
- Check my wallet balance
```

#### Send Tokens

```
Commands:
- Send 100 FLIX to omniflix1abc123...
- Transfer 50 FLIX to omniflix1xyz789...
```

#### Check Staked Balance

```
Commands:
- What is my staked balance?
- Show my delegated FLIX
- Check my staking balance
```

### 2. Staking Operations

#### Delegate Tokens

```
Commands:
- Delegate 100 FLIX to omniflixvaloper1abc123...
- Stake 50 FLIX with validator omniflixvaloper1xyz789...
```

#### Undelegate Tokens

```
Commands:
- Undelegate 100 FLIX from omniflixvaloper1abc123...
- Unstake 50 FLIX from validator omniflixvaloper1xyz789...
```

#### Redelegate Tokens

```
Commands:
- Redelegate 100 FLIX from omniflixvaloper1abc123... to omniflixvaloper1def456...
- Move 50 FLIX stake from validator1 to validator2
```

#### Cancel Unbonding

```
Commands:
- Cancel unbonding of 100 FLIX from omniflixvaloper1abc123... at creation height 123456
- Stop unbonding 50 FLIX from validator omniflixvaloper1xyz789... at creation height 789012
- Cancel unbonding delegation with:
  - Amount: 100 FLIX
  - Validator: omniflixvaloper1abc123...
  - Creation Height: 123456
```

Note: Creation height is required for canceling unbonding operations. You can find the creation height:

- In the unbonding delegation response
- Through the chain explorer
- From the original unbonding transaction

### 3. Governance Operations

#### Vote on Proposals

```
Commands:
- Vote yes on proposal 1
- Vote no on proposal 2
- Vote abstain on proposal 3
- Vote no_with_veto on proposal 4


Valid Options:
- yes
- no
- abstain
- no_with_veto

Note: proposal Id and vote option is required for voting on proposals or it will take unspecified vote option. You can find the proposal ID:

- In the proposal response
- Through the chain explorer
- From the original proposal transaction
```

## Integration

### Basic Setup

1. Import the plugin:

```typescript
import { OmniflixPlugin } from "@elizaos/plugin-omniflix";
```

2. Register with ElizaOS:

```typescript
import { Eliza } from "@elizaos/core";

const eliza = new Eliza();
eliza.registerPlugin(OmniflixPlugin);
```

### Example Usage

```typescript
import { voteOnProposal } from "@elizaos/plugin-omniflix";

// Vote on a proposal
const voteOnProposal = await voteOnProposal(
    {
        proposalId: "1",
        vote: "YES",
    },
    {
        apiEndpoint: "https://rest.omniflix.network",
        rpcEndpoint: "https://rpc.omniflix.network:443",
    }
);
```

## Technical Details

### Token Denominations

- Display denomination: FLIX
- Base denomination: uflix (auto-converted by plugin)

### Address Formats

- Wallet addresses: Start with `omniflix`
- Validator addresses: Start with `omniflixvaloper`

### Staking Parameters

- Unbonding period: 28 days
- Redelegation: Has cooldown period
- Delegation: Minimum amount may apply
- Unbonding cancellation requires:
    - Validator address
    - Amount
    - Creation height (block height when unbonding started)
    - Must be within unbonding period

### Governance Rules

- Voting eligibility: Proposals must be in voting period
- Voting frequency: One vote per address per proposal
- Voting power: Proportional to staked amount

## License

This plugin is part of the ElizaOS project. See LICENSE file for details.
