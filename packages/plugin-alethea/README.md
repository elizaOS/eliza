# Alethea AI Plugin for ElizaOS

This plugin bootstraps **Alethea AI** support for ElizaOS agents.  
It lays the groundwork for future actions that will interact with Alethea's AliAgent, INFT, Hive, token, governance and market-data APIs.

## Features

- **Convert NFT to ALI Agent**: Transform an ERC-721 NFT into an intelligent ALI Agent (Base Network)
- **Convert iNFT to ALI Agent**: Transform an iNFT into an ALI Agent (Ethereum Mainnet)
- **Keys Trading**: Buy and sell keys for ALI Agents
- **Pod Operations**: Fuse pods with ALI Agents
- **Hive Operations**: Create liquidity pools and distribute tokens
- **Token Operations**: Deploy and airdrop ALI Agent or Hive utility tokens

## Core Workflow

The main Alethea AI workflow is:

1. **Start with existing NFT/iNFT** (user owns)
2. **Convert to ALI Agent** using Keys Factory contract
3. **Trade keys** for the ALI Agent
4. **Additional operations** like pods, hives, etc.

**No custom token deployment needed** - ALI Agents are created from existing NFTs!

## Installation

```bash
npm install
```

## Configuration

---

## 🔧 Configuration

The plugin reads its credentials from environment variables **or** from the agent's `character.settings.secrets` block.

| Variable           | Description                                     | Required |
| ------------------ | ----------------------------------------------- | -------- |
| `ALETHEA_RPC_URL`  | JSON-RPC endpoint for Alethea chain             | ✅       |
| `PRIVATE_KEY`      | Signer private key used for authenticated calls | ✅       |
| `ALETHEA_API_KEY`  | Alethea SDK / REST API key (if applicable)      | ✅       |
| `SNAPSHOT_API_URL` | URL for the Snapshot API (optional)             | ❌       |

Create/extend your project `.env`:

```env
# Alethea AI Plugin
ALETHEA_RPC_URL=https://api.alethea.ai
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
ALETHEA_API_KEY=your_alethea_api_key
SNAPSHOT_API_URL=https://hub.snapshot.org
```

**Required for Airdrop Operations:**

- `ALETHEA_RPC_URL`: Base Network RPC endpoint
- `PRIVATE_KEY`: Wallet private key with tokens to distribute

## Usage

### Convert NFT to ALI Agent (Base Network)

```typescript
'Convert my NFT at address 0x123... token ID 42 to an ALI Agent using ETH implementation';
```

### Convert iNFT to ALI Agent (Ethereum Mainnet)

---

## ⚡ Available Actions

### Governance

#### `PARTICIPATE_IN_VOTE`

Casts a vote on a Snapshot proposal.

**Similes:** `VOTE`, `CAST_VOTE`, `PARTICIPATE_IN_GOVERNANCE`

**Parameters:**

- `space` (string): The Snapshot space (e.g., `alethea-ai.eth`).
- `proposalId` (string): The ID of the proposal.
- `choice` (number | string): The vote choice (e.g., `1` for "yes").

**Example Usage:**
`Vote on proposal 0xabc...def in space alethea-ai.eth with choice 1.`

#### `HANDLE_GOVERNANCE_ERRORS`

Handles and interprets AI Protocol governance errors (550–558).

**Similes:** `PROCESS_ERROR`, `HANDLE_ERROR`, `MANAGE_GOVERNANCE_ERROR`

**Parameters:**

- `error` (object): The error object, which should contain a `code` property.

**Example Usage:**
`I received a governance error with code 551. What does it mean?`

**Error Code Mapping:**
| Code | Message |
| ---- | -------------------------------------------------------------------------- |
| 550 | "Interaction nuances are refined to uphold our community standards." |
| 551 | "Guides the ALI Agent creation process to ensure content integrity." |
| 552 | "Curates Dream content to maintain harmony with community values." |
| 553 | "Shapes Avatar Images to reflect our shared respect and creativity." |
| 554 | "Oversees Dream Cover Image creation to align with our collective ethos." |
| 555 | "Guides Background Image creation for Dreams, ensuring a positive space." |
| 556 | "Assists in crafting Creator Bios that welcome and inspire." |
| 557 | "Manages ALI Agent Profile adjustments to resonate with our guidelines." |
| 558 | "Curates Dream updates to foster a safe and inspiring environment." |

---

## 🗂️ Project Structure

```

```
