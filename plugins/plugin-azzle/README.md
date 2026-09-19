# @elizaos/plugin-azzle

AZZLE V2 task-lifecycle actions for Base mainnet (`8453`).

## Actions

- `POST_AZZLE_TASK`
- `CLAIM_AZZLE_TASK`
- `FUND_AZZLE_TASK`
- `MARK_AZZLE_TASK_DELIVERED`
- `RELEASE_AZZLE_ESCROW`
- `COMPLETE_AZZLE_TASK`

All amounts are AZL wei. Tasks use canonical IDs: `v2:standard:N` or
`v2:micro:N`. Price negotiation is offchain and not represented as a contract
action.

## Wallet integration

Create the plugin with a V2 manifest, Base RPC URL, and a viem-compatible
wallet client. The wallet must report `chain.id === 8453` and implement
`getAddresses()` and `sendTransaction()`. The plugin does not load private
keys and does not embed protocol addresses.

```ts
import { createAzzlePlugin } from "@elizaos/plugin-azzle";

const plugin = createAzzlePlugin({
  manifest: runtimeLoadedAzzleManifest,
  rpcUrl: process.env.AZZLE_BASE_RPC_URL!,
  wallet: viemWalletClient,
});
```

`AZZLE_TASK_STATUS` is a read-only provider that reports the onchain state for
a canonical task ID present in the message.
