# @elizaos/plugin-aomi

Delegates natural-language on-chain workflows from an Eliza agent to Aomi
without moving wallet custody or transaction approval outside elizaOS.

## Capabilities

- Sends open-ended research, simulation, DeFi, and transaction requests to
  Aomi.
- Keeps one Aomi thread per Eliza room so follow-up requests retain context.
- Connects the configured `@elizaos/plugin-wallet` EVM and Solana addresses to
  Aomi.
- Stops every wallet request at an exact transaction or signature preview.
- Requires a separate user confirmation turn before signing or submission.
- Supports single-call EVM transactions, EIP-712 and message signatures,
  Solana transaction signatures, Solana message signatures, and Solana
  sign-and-send requests.

## Install

```bash
bun add @elizaos/plugin-aomi @elizaos/plugin-wallet
```

Add both plugins to the character:

```ts
plugins: ["@elizaos/plugin-wallet", "@elizaos/plugin-aomi"];
```

Configure at least one wallet signing path supported by
`@elizaos/plugin-wallet`. No Aomi credential is required for the public
`default` app.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOMI_API_URL` | `https://api.aomi.dev` | Aomi backend base URL |
| `AOMI_API_KEY` | unset | Private Aomi app API key |
| `AOMI_APP` | `default` | Aomi app key |
| `AOMI_APPLICATION_ID` | unset | Concrete Aomi application id |
| `AOMI_CHAIN_ID` | `1` | Default EVM chain id |
| `AOMI_EVM_RPC_URL` | chain default | RPC override for Aomi-built EVM transactions |

Wallet variables such as `EVM_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`, and
`SOLANA_RPC_URL` are owned by `@elizaos/plugin-wallet`.

## Confirmation flow

1. The user asks the agent to use Aomi for an on-chain task.
2. Read-only tasks return immediately.
3. When Aomi requests a wallet operation, the plugin displays the exact target,
   chain, value, call count, or signature type.
4. The user replies `yes` to execute or anything else to reject.
5. The plugin signs through `WalletBackendService`, submits when required, and
   resumes the same Aomi thread with the result.

The initiating prompt never authorizes a write. LLM-supplied confirmation flags
are ignored; confirmation state is held by the elizaOS runtime.

## Development

```bash
bun install
bun run --cwd plugins/plugin-aomi typecheck
bun run --cwd plugins/plugin-aomi lint:check
bun run --cwd plugins/plugin-aomi test
bun run --cwd plugins/plugin-aomi build
```

Set `ELIZA_E2E_AOMI=1` to run the live Aomi contract test.

For the opt-in wallet E2E, point `AOMI_EVM_RPC_URL` and `AOMI_CHAIN_ID` at a
supported testnet or chain `31337` fork, provide a funded `EVM_PRIVATE_KEY`, and
run `bun run test:wallet-live`. The test refuses production chain ids, records
the transaction hash and balance change, and verifies a real insufficient-funds
failure with a fresh empty signer.
