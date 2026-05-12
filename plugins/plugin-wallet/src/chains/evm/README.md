# @elizaos/plugin-wallet — EVM chain

EVM chain implementation inside `@elizaos/plugin-wallet`. Provides token transfers, cross-chain bridging, token swaps via LiFi, and DAO governance helpers across all major EVM-compatible chains.

## Features

- **Multi-chain Support**: Ethereum, Base, Arbitrum, Optimism, Polygon, and 10+ more chains
- **Native Token Transfers**: Send ETH, MATIC, BNB, and other native gas tokens
- **ERC20 Token Transfers**: Send any ERC20 token
- **Cross-chain Bridging**: Bridge tokens between chains via LiFi
- **Token Swaps**: Exchange tokens on supported DEXs
- **DAO Governance**: Propose, vote, queue, and execute proposals
- **Strong Typing**: Branded types with Zod schemas, fail-fast validation

## Supported Chains

| Chain             | ID       | Native Token |
| ----------------- | -------- | ------------ |
| Ethereum Mainnet  | 1        | ETH          |
| Sepolia (testnet) | 11155111 | ETH          |
| Base              | 8453     | ETH          |
| Base Sepolia      | 84532    | ETH          |
| Arbitrum One      | 42161    | ETH          |
| Optimism          | 10       | ETH          |
| Polygon           | 137      | MATIC        |
| Avalanche C-Chain | 43114    | AVAX         |
| BNB Smart Chain   | 56       | BNB          |
| Gnosis            | 100      | xDAI         |
| Fantom            | 250      | FTM          |
| Linea             | 59144    | ETH          |
| Scroll            | 534352   | ETH          |
| zkSync Era        | 324      | ETH          |
| Radius Network    | 723487   | RUSD         |
| Radius Testnet    | 72344    | RUSD         |

## Installation

```bash
bun add @elizaos/plugin-wallet
# or
npm install @elizaos/plugin-wallet
```

## Quick Start

```typescript
import { evmPlugin, EvmService } from "@elizaos/plugin-wallet";

// Add to your agent
const agent = createAgent({
  plugins: [evmPlugin],
});

// Or use the service directly
const service = new EvmService();
await service.initialize(runtime);

// Get wallet info
const address = service.getAddress();
const balance = await service.getBalance("mainnet");
```

## Strong Typing (Zod + Branded Types)

```typescript
import { ZAddress, ZTransferParams } from "@elizaos/plugin-wallet";

// Validated at runtime
const address = ZAddress.parse("0x1234..."); // Throws if invalid
const params = ZTransferParams.parse({
  fromChain: "mainnet",
  toAddress: "0x...",
  amount: "1.0",
});
```

## Directory Structure

```
plugins/plugin-wallet/src/chains/evm/
├── actions/              # Transfer, swap, bridge, governance actions
├── providers/            # EVM wallet provider
├── types/                # Branded types and Zod schemas
├── contracts/            # ABI bindings
├── prompts/              # Action prompt specs
├── generated/            # Auto-generated docs
├── service.ts            # EvmService entry
├── rpc-providers.ts      # Provider routing (Alchemy / Infura / Ankr / elizacloud)
└── index.ts              # Module entry
```

## Configuration

| Environment Variable                         | Required | Description                                                                                                |
| -------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `EVM_PRIVATE_KEY`                            | Yes      | Private key for the agent's wallet (hex, starting with `0x`)                                              |
| `EVM_RPC_PROVIDER`                           | No       | Default RPC provider preference: `alchemy` / `infura` / `ankr` / `elizacloud`                            |
| `ALCHEMY_API_KEY` / `INFURA_API_KEY` / `ANKR_API_KEY` | No | API keys for the corresponding RPC provider                                                                |
| `ETHEREUM_PROVIDER_<CHAIN>`                  | No       | Custom RPC URL override (e.g. `ETHEREUM_PROVIDER_BASE`, `ETHEREUM_PROVIDER_ARBITRUM`)                     |
| `TEE_MODE`                                   | No       | Trusted Execution Environment mode (`OFF` / `ON`)                                                          |
| `WALLET_SECRET_SALT`                         | No       | Salt for TEE-derived wallet keypair                                                                        |
| `SEPOLIA_RPC_URL` / `BASE_SEPOLIA_RPC_URL`   | No       | Custom testnet RPC URLs                                                                                    |

## License

MIT — see [LICENSE](./LICENSE).
