# #12275 elizaOS Deploy Corrupt Input

## Scope

This chunk covers the CLI deploy command's corrupt local-input handling:

- `packages/elizaos/src/commands/deploy.ts`
- `packages/elizaos/src/commands/deploy.test.ts`

`elizaos deploy` no longer treats corrupt `.elizaos/template.json` or corrupt
`~/.elizaos/credentials.json` as simply missing. It now fails fast with a clear
invalid JSON message and exits non-zero before app lookup or deploy requests.

## Built CLI Evidence

After rebasing on `origin/develop` and rebuilding `packages/elizaos`, I ran the
actual built CLI against real temporary files.

Corrupt project metadata:

```bash
tmp=$(mktemp -d)
mkdir -p "$tmp/.elizaos"
printf '{not-json' > "$tmp/.elizaos/template.json"
(cd "$tmp" && NO_COLOR=1 ELIZAOS_CLOUD_API_KEY=eliza_test_key node /Users/shawwalters/.codex/worktrees/8855/eliza/packages/elizaos/dist/cli.js deploy)
```

Observed:

```text
exit=1
Invalid project metadata JSON at .../.elizaos/template.json: Expected property name or '}' in JSON at position 1 (line 1 column 2)
```

Corrupt credentials:

```bash
home=$(mktemp -d)
mkdir -p "$home/.elizaos"
printf '{not-json' > "$home/.elizaos/credentials.json"
NO_COLOR=1 HOME="$home" node /Users/shawwalters/.codex/worktrees/8855/eliza/packages/elizaos/dist/cli.js deploy --app-id app-1
```

Observed:

```text
exit=1
Invalid Eliza Cloud credentials JSON at .../.elizaos/credentials.json: Expected property name or '}' in JSON at position 1 (line 1 column 2)
```

## Verification Commands

Passed:

```bash
git fetch origin && git rebase --autostash origin/develop
bun run --cwd packages/elizaos test -- src/commands/deploy.test.ts
bun run --cwd packages/elizaos typecheck
bun run --cwd packages/elizaos lint:check
bun run --cwd packages/elizaos build
bun run audit:error-policy-ratchet
```

The focused deploy test passed:

```text
Test Files  1 passed (1)
Tests       9 passed (9)
```

Root verify was attempted:

```bash
bun run verify
```

It passed the AGENTS/CLAUDE check, type-safety ratchet, error-policy ratchet,
and 79 Turbo tasks before failing in unrelated cloud API typecheck:

```text
Failed: @elizaos/cloud-api#typecheck
packages/cloud/api/__tests__/hf-proxy-route.test.ts(259,38): error TS2769
packages/cloud/shared/src/lib/services/market-preview.ts: missing exports from @elizaos/shared
```

## Evidence Matrix

- Screenshots: N/A - CLI-only change with no UI surface.
- Video walkthrough: N/A - CLI transcript above captures the end-to-end command.
- Frontend console/network logs: N/A - no frontend surface changed.
- Backend logs: N/A - the command fails before network/backend interaction.
- Real-LLM trajectories: N/A - no prompt, model, action, provider, or agent
  behavior changed.
- Domain artifacts: real temporary `.elizaos/template.json` and
  `.elizaos/credentials.json` corrupt files were used in the CLI transcript.
