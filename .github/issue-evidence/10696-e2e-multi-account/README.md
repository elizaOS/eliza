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
- Settings UI screenshots (desktop + mobile) + in-chat account panel: captured in the app-build pass (`desktop-*.png` / `mobile-*.png` added alongside)
