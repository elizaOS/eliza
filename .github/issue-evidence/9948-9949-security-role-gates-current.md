# #9948 / #9949 - current branch validation rollup

Date: 2026-06-29 UTC
Branch: `fix/9948-9949-security-role-gates`

## Validation Run

Passed after `bun install` and rebasing on `origin/develop` at `06d475e67f`:

```bash
bun run verify
```

Result: `493 successful, 493 total` in Turbo, followed by passing build-model, Turbo dependency, TEE secret leak, script, and dist-path consumer audits. The dist-path check covered `28` consumer configs.

## Focused Checks

Passed:

```bash
bun test packages/core/src/features/trust/__tests__/should-respond-risk-gate.test.ts packages/core/src/roles.test.ts packages/core/src/security/external-content.test.ts
bun run --cwd packages/agent test -- src/api/public-route-audit.test.ts src/api/auth-routes.role.test.ts
bun run --cwd packages/app-core test -- src/api/__tests__/ensure-min-role.test.ts src/api/__tests__/ensure-route-min-role.test.ts
bun run --cwd packages/ui test -- src/components/RoleGate.test.tsx src/components/ShellRoleProvider.test.tsx
bun run --cwd packages/ui lint
bun run --cwd plugins/plugin-wallet test -- src/chains/evm/routes/sign.test.ts src/chains/solana/routes/sign.test.ts src/plugin.routes.test.ts src/security/__tests__/wallet-context-safety.test.ts
bun run --cwd packages/cloud/api lint
```

## Evidence Status

- #9949 live-model trajectory/logs: `.github/issue-evidence/9949-should-respond-injection-gate.md`.
- #9948 backend and role-boundary tests: covered by the focused checks above plus root `verify`.
- #9948 UI screenshots: existing same-day artifacts remain in `.github/issue-evidence/9948-rolegate/` and `.github/issue-evidence/9948-shell-rolewiring/`; this branch did not change `packages/app/`.
- Real-LLM trajectory for #9948: N/A; the #9948 work is HTTP role/wallet/UI authorization, not model behavior.
- Audio/native-device artifacts: N/A; no audio, mobile bridge, or native-device behavior changed in this branch.
