# @elizaos/plugin-workflow

Native [Smithers](https://www.npmjs.com/package/smthrs) workflows for elizaOS.

Workflows are executable TS/TSX modules, authored from chat or the Workflows studio and run behind elizaOS authentication, tenancy, Cloud APIs, scheduling, and model routing. The integration does not run a Smithers Gateway. Native Smithers progress, outputs, approvals, and widget metadata are surfaced through elizaOS run records and UI.

See [CLAUDE.md](./CLAUDE.md) for the source contract, architecture, routes, and validation commands.

`ELIZA_SMTHRS_TIMEOUT_MS` optionally sets the worker deadline in milliseconds. It accepts canonical decimal integers from `1` through `2147483647`; invalid configuration fails before worker startup.

## Validation scenarios

The integration is pinned to Smithers 0.35.0. Run the isolated package suite with
`bun run --cwd plugins/plugin-workflow test`. Its real-runner scenarios cover:

- complete output passed between dependent tasks, persisted rows, and reuse of a completed run without replaying model calls;
- invalid render errors and finite retry budgets for malformed model output;
- approval-gated execution that resumes only after a persisted decision;
- external signals that resume a waiting workflow with the complete payload;
- timeout, cancellation, inherited child pipes, and delayed event delivery.

`bun run --cwd packages/app test:e2e:workflow-real` exercises authoring, event
triggers, execution output, widgets, and reload persistence through the browser
and a real local runtime. That lane uses a deterministic model bridge; it is
separate from credentialed model validation. Use `E2E_RECORD=1` with the app's
`test:e2e` runner when collecting video and trace evidence.

The coding-task integration has a live subscription lane:

```bash
RUN_LIVE_SMITHERS_SUBSCRIPTION=1 bun run --cwd plugins/plugin-agent-orchestrator test -- __tests__/live/smithers-codex-subscription.live.test.ts
```

It requires an authenticated Codex subscription and checks an exact model
response through the durable Smithers worker and native ACP transport. The
managed Codex adapter is pinned to 1.10.0; startup diagnostics are negotiated as
typed records and retained separately from the model answer. Run the owning
package checks and root `bun run verify` after changing either dependency.
