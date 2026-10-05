# @elizaos/plugin-personal-assistant

Owner operations and cross-domain personal-assistant orchestration for Eliza agents.

Composes owner operations across domain plugins. Use the shared scheduling runner,
entity/relationship stores, and attachment store. Load the database adapter and required
domain/connector plugins first. Household documents remain owner-private unless an
explicit current grant authorizes access.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-personal-assistant build  # build
bun run --cwd plugins/plugin-personal-assistant test   # tests
```

The managed morning brief follows authenticated owner foreground activity after the configured owner-day boundary (04:00 by default), with admission and day consumption persisted on its scheduled-task row. Manual refresh is separate; customized schedules are preserved. Android requires an authenticated user-present report with an unlocked, interactive device; iOS uses foreground events. Client reports are not OS attestation. Duplicate defaults and unresolved legacy delivery require reconciliation.


### Native bill task composition

`native-host/*.mjs` provides host-only bill discovery, complete PDF interpretation,
explicit source selection, durable submission/outcome records, and workflow
composition over the agent's `InteractiveTaskRuntime` and browser's
`NativeTaskActuator`. It reuses the host's task database and owner authorization;
it does not create a scheduler, connector identity, autonomous payment action,
or replacement task engine. `bill_outcomes_v1` and source/attempt/review tables
are task-owned domain evidence, including uncertain submissions that must survive
restarts to prevent repeated preparation.

Hosts must supply reviewed `deriveBillDecision` and exact `controls` policy.
Neither may come from renderer input, page instructions or a model response.
Bill-source parsing and provider/account scope are also explicit host inputs.
The plugin's confidence-based `src/lifeops/bill-extraction.ts` remains a separate
inbox classification API; its result alone is not payment authorization.
The test-biller text contract and control labels exist only in test fixtures.
Application packaging, private startup configuration, and UI remain with hosts.

Run `bun run test:bill-host` for discovery, revocation, exact-money parsing,
selection, SQLite durability and submission-uncertainty checks. These tests use
synthetic connectors and real task/SQLite persistence where applicable; they do
not prove live account or biller acceptance.

`createBillTaskRoutes` composes bill discovery/selection, review choices and latest
outcomes into the app task gateway extension. It receives the existing task
runtime, SQLite stores, workflow policy and four required presentation strings
from the host. Authorization is rechecked after asynchronous work; source
selection and duplicate choice delivery retain their durable task bindings.
Product helper descriptions, support/study routes and UI copy stay with hosts.

The native bill-outcome store's `loadEvidence()` returns the current observation
and whether that exact validated record is persisted. Host reports can distinguish
pending observations from durable evidence without querying the store's tables.
