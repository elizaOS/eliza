# @elizaos/contracts

Shared browser-safe domain DTOs, constants and input validation used by plugins,
hosts and renderers. Import the public barrel; internal files import definitions
directly. Storage, authorization, identity merging and effects remain with their
runtime or domain owners.

From the repository root, run `bun run --cwd packages/contracts build` and
`bun run --cwd packages/contracts typecheck`. Integration regressions remain in
their domain owners.

Use `@elizaos/contracts` for browser-safe DTOs and validators. Node signing and verification contracts use `@elizaos/contracts/node`. Persisted backup versions and canonical bytes remain supported.

Device-review contracts cover foreground Calendar availability, Notes search and
name-targeted edits. Domain owners supply record validators; hosts retain local
selection, permission and approval. A no-match receipt reports no change.

`@elizaos/contracts/device-action-execution` shares immutable attempt identity
and a single-dispatch renderer guard. Hosts retain authenticated requests,
foreground consent, durable journal transitions and result admission. Retirement
blocks dispatch but does not discard a known result of an admitted attempt.
The guard does not grant retry permission or replace journal recovery.

`@elizaos/contracts/phone-workflow` is the single normalizer, catalog and
save-receipt reader for typed phone workflows, so the agent's reviewed compiler
and phone clients bind the same canonical bytes. Its manual and reviewed
local-time triggers are data, never execution authority: a local-time schedule
is armed per reviewed version on the agent's durable scheduler, an occurrence
that passes while the agent is not running is recorded once as missed and never
run later, and every phone read or effect still needs its own device approval.

`@elizaos/contracts/notice-routes` is the renderer side of the native notice
routes: the owner privacy fence coordinator, tap resolution through
authenticated reads of the exact route, the installed approval notice identity
and the owner-return revalidation of a suspended approval notice. A tap is a read
request; hosts retain the native ledgers, foreground checks and presentation.

`@elizaos/contracts/workflow-client` is the receipt-checked client for the
workflow agent routes: listing, exact-version activation and runs, approval
receipts and decisions, metadata edits, removal and restore, typed generation,
validation and saves, and reconciliation by submission or mutation identity.
The host supplies the transport, so the client never chooses a local or linked
agent on its own. Each mutation records its identity before it is sent; only the
agent's refusal of that exact identity is reported as not applied, and any other
failure leaves the outcome unknown until reconciled. The agent admits a
submission identity at most once, so a resend cannot start a second run.
