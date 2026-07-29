# @elizaos/plugin-aomi

Delegates on-chain intent to Aomi while elizaOS owns wallet custody, explicit
confirmation, signing, and submission.

## Surface

- `AOMI` is the only action. It starts a request, pauses on wallet envelopes,
  and resumes the exact request after a later confirmation or rejection.
- `AomiService` owns one `ClientSession` per Eliza room and prevents concurrent
  turns from sharing or replacing pending wallet state.
- `aomiProvider` exposes configuration, connected addresses, and a bounded
  pending-operation preview to the planner.
- `wallet.ts` is the only execution boundary. It reaches signing exclusively
  through `WalletBackendService`; never read private keys in this plugin.

## Invariants

- A wallet request cannot execute on the turn that created it.
- A confirmation is keyed to the room and exact Aomi request id.
- Store a submitted transaction result before notifying Aomi so a failed
  callback retry cannot broadcast twice.
- EVM batches are rejected until the wallet backend provides an atomic batch
  primitive; never submit a partial batch.
- Do not add a second action for confirmation. The runtime confirmation helper
  and follow-up-capable `AOMI` action own the two-turn flow.
- Do not expose API keys, wallet keys, signed payloads, or raw backend errors in
  provider text.

## Commands

```bash
bun run --cwd plugins/plugin-aomi typecheck
bun run --cwd plugins/plugin-aomi lint:check
bun run --cwd plugins/plugin-aomi test
bun run --cwd plugins/plugin-aomi build
bun run --cwd plugins/plugin-aomi test:live
```

## Configuration

`AOMI_API_URL`, `AOMI_API_KEY`, `AOMI_APP`, `AOMI_APPLICATION_ID`,
`AOMI_CHAIN_ID`, and `AOMI_EVM_RPC_URL` belong to this plugin. Wallet and RPC
credentials otherwise belong to `@elizaos/plugin-wallet`.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## Evidence and real end-to-end validation

The binding standard is [AGENTS.md](../../AGENTS.md). Agent/action changes
require a manually reviewed live-model trajectory. Wallet changes require a
testnet transaction hash, explorer link, balance before/after, signed-payload
trail, and real failure-path evidence. Attach evidence inline to the PR; do not
commit generated evidence artifacts.
<!-- END: evidence-and-e2e-mandate -->
