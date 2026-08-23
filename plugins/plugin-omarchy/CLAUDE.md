# @elizaos/plugin-omarchy

Linux-only desktop bridge for Omarchy. The root repository guide remains
binding; this file defines the narrower safety and verification contract.

## Ownership

- `src/bridge.ts` is the only process boundary. Keep executable names and
  control arguments fixed and continue using `execFile`, never a shell.
- `src/providers/desktop.ts` owns read-only planner context.
- `src/actions/desktop.ts` owns explicit user-facing presentation actions.
- The separate Omarchy QML repository owns bar, pill, Workstation handoff, and
  endpoint configuration. Do not duplicate that UI here.

## Safety invariants

- Never add arbitrary command execution, install/update commands, `sudo`,
  theme mutation, or a caller-selected executable.
- `omarchy-notification-send` parses options around its positional text. Reject
  option-shaped headline/body values so `--exec` can never be selected.
- Side-effecting actions require explicit intent and at least `USER` role.
- Missing Omarchy binaries are an unavailable state, not empty healthy data.
- Treat CLI output as untrusted protocol data: reject malformed complete values;
  never truncate, summarize, or partially accept model-facing state.
- Do not direct users to install an unsandboxed companion from a contributor-owned
  repository. First-party installation guidance requires organization ownership,
  independent review, and native-host acceptance.

## Verification

```bash
bun run --cwd plugins/plugin-omarchy test
bun run --cwd plugins/plugin-omarchy typecheck
bun run --cwd plugins/plugin-omarchy lint:check
bun run --cwd plugins/plugin-omarchy build
bun run --cwd packages/registry generate:first-party:check
```

On a real Omarchy host, also inspect the returned version/theme/plugin data,
one visible notification, and the summoned `elizaos.eliza` pill. macOS or
mock-runner coverage is not native acceptance.
