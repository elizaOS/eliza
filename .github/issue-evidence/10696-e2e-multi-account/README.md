# #10696 — real E2E for multi-account sign-in, switching, round-robin, token/usage refresh

Proof that **more than one Claude account AND more than one Codex account** truly
work: distinct per-account credentials, strategy switching, round-robin rotation,
priority reordering, rate-limit failover, and a loud readiness gate — all over the
**real** on-disk credential store + `AccountPool` + `coding-account-bridge`, no
in-memory stubs.

## Reproducer (runs in CI, no secrets)

`packages/app-core/src/services/multi-account-rotation.test.ts` — 8 tests driving
the real pool + bridge over a throwaway `ELIZA_HOME`:

```
bun run --cwd packages/app-core test -- multi-account-rotation
```

Covers, per #10696 acceptance:
- two accounts per subscription tier surface in `pool.list()` + `bridge.describe()`
- round-robin **alternates** across both accounts (distinct token each turn)
- **priority reorder** changes which account is served first
- rate-limiting the active account **hands off to the sibling with no dropped request**
- each Codex account materializes its **own** `CODEX_HOME/auth.json`, each Claude
  account injects its **own** `CLAUDE_CODE_OAUTH_TOKEN` — **zero cross-account bleed**
- pool metadata (priority/enabled) **round-trips** through `_pool-metadata.json`
  across a pool reset (restart)
- disabled / re-enabled accounts leave / rejoin rotation

## Captured domain artifacts

`on-disk-artifacts.txt` — a run of `gen-multi-account-artifacts.mjs` that seeds 2
Claude + 2 Codex accounts and dumps the **actual bytes**:
- `<stateDir>/auth/` tree (two files per tier)
- each credential record with a **distinct** access token
- `_pool-metadata.json` (the non-secret overlay: label/enabled/priority/health)
- round-robin selection trace (personal → work → personal → work)
- per-account `_codex-home/<accountId>/auth.json` with **distinct**
  `access_token` + `account_id` + `id_token` (no bleed)
- rate-limit failover (`claude-personal` 429 → served `claude-work`, health flips)
- `assessCodingAccountReadiness({rotation:true})` = **ready** with 2 healthy each,
  and **flags the degraded pool loudly** after the 429 (#9960 loud gate)

Tokens are redacted to a prefix + length; they are synthetic-but-structurally-real
(the only synthetic element — a real 2nd Anthropic/OpenAI subscription is a human
OAuth step).

## Still requires the human (live OAuth)

The one thing automation cannot do is perform a **real** second OAuth login to
Anthropic/OpenAI. The live proof is the secret-gated lane
`orchestrator-live-multi-account.yml` (`ELIZA_LIVE_CLAUDE_OAUTH_TOKEN_1[/_2]`,
`ELIZA_LIVE_CODEX_AUTH_JSON_1[/_2]`), which now also asserts
`assessCodingAccountReadiness` after seeding. Operator flow to connect a 2nd
account of each tier and capture the live trace:
`Settings → AI models → Add account` (or the in-chat account panel), then
`bun run --cwd plugins/plugin-agent-orchestrator export:ci-account-secrets`.

## Evidence checklist (per PR_EVIDENCE.md)

- Domain artifacts (on-disk store, pool metadata, per-account CODEX_HOME): **attached** (`on-disk-artifacts.txt`)
- Automated real-path E2E: **attached** (`multi-account-rotation.test.ts`, 8/8 green, in CI)
- Backend `[ClassName]` logs (`[coding-account-bridge] … via <strategy>`): present in the E2E + live-lane output
- Real-LLM trajectory: N/A for selection mechanics; the live lane proves a pooled credential authenticates
- **In-chat AccountConnectBlock screenshots**: **attached** — `inchat-account-connect-desktop.png` + `inchat-account-connect-mobile.png` (Storybook `Chat/MessageContent → AccountConnect`, desktop 1280×800 + mobile 390×844); verdict in `manual-review-inchat-account-connect.md` (**good**). This capture caught + fixed a real bug (the count read the literal `{{count}}`).
- **Settings AI-model account UI** (`AccountList` / `RotationStrategyPicker` / `AddAccountDialog`): the **existing, already-audited** surface — this PR does not change it. Its stories are backend-driven (they fetch live accounts), so they are captured by the full-app tool, not static Storybook: `ELIZA_SETTINGS_AUDIT=1 bun run --cwd packages/app test:e2e -- settings-audit-capture` (or `audit:app`) with two accounts seeded per tier. The on-disk artifacts above prove the rotation/priority/health the UI displays.
- **Per-platform**: the accounts UI is the **shared React shell** — the in-chat block is captured at desktop + mobile (390×844) viewports; native iOS/desktop render the identical tree (per this issue's own spec, native capture is N/A for a shared-shell flow unless it renders differently, which it does not).
