# #13574 host-agent lane encapsulation evidence

## Change

- Added `packages/app/scripts/lib/host-agent.mjs`, a shared helper that starts `packages/app-core/scripts/serve-real-local-agent.ts`, chooses `:31338` or a free port, waits for `/api/health`, writes `host-agent.log` into the lane artifact directory, and tears down the child process.
- `ios-onboarding-smoke.mjs` and `ios-attachment-smoke.mjs` now start that helper by default when `--api-base` is omitted. Existing `--api-base` callers still own the server.
- `mobile-local-chat-smoke.mjs` gained explicit `--start-host-agent` / `--host-agent-port` flags.
- `.github/workflows/mobile-build-smoke.yml` now calls the script lanes directly instead of carrying three copies of host-agent boot/poll/cleanup shell.

## Verification run locally

```bash
node --check packages/app/scripts/lib/host-agent.mjs
node --check packages/app/scripts/lib/host-agent.test.mjs
node --check packages/app/scripts/ios-onboarding-smoke.mjs
node --check packages/app/scripts/ios-attachment-smoke.mjs
node --check packages/app/scripts/mobile-local-chat-smoke.mjs
```

Result: passed.

```bash
bun run --cwd packages/app test -- scripts/lib/host-agent.test.mjs
```

Result: passed, 1 file / 4 tests. The test starts a real child HTTP process, waits for `/api/health`, verifies `ELIZA_PAIRING_DISABLED=1`, writes `host-agent.log`, stops the child, and proves the port is closed.

```bash
bunx biome check packages/app/scripts/lib/host-agent.mjs packages/app/scripts/lib/host-agent.test.mjs packages/app/scripts/ios-onboarding-smoke.mjs packages/app/scripts/ios-attachment-smoke.mjs packages/app/scripts/mobile-local-chat-smoke.mjs .github/workflows/mobile-build-smoke.yml
git diff --check
```

Result: passed.

```bash
bun run verify
```

Result: failed before package typecheck/lint in `audit:type-safety-ratchet` on repo-wide baseline drift unrelated to this patch:

- `as unknown as`: 74 current > 73 baseline.
- `?? []` in core/agent/app-core: 582 current > 581 baseline.

```bash
node packages/app/scripts/mobile-local-chat-smoke.mjs --help
```

Result: help output includes `--start-host-agent` and `--host-agent-port`.

## Real host-agent attempt

Attempted to start the actual deterministic host agent through `startDeviceE2eHostAgent()` and poll `/api/health`. The helper correctly captured the child output and failed loudly because this machine has Node v23.3.0 and `run-node-tsx` requires Node 24+.

Artifact: `host-agent-node23-failure.txt`.

## Simulator proof not run locally

The required real simulator commands need a full Xcode install. This machine is pointed at Command Line Tools and `simctl` is unavailable:

```bash
xcode-select -p
# /Library/Developer/CommandLineTools

xcrun simctl list devices booted --json
# xcrun: error: unable to find utility "simctl", not a developer tool or in PATH
```

Commands still required on a macOS/Xcode runner or developer machine:

```bash
bun run --cwd packages/app build:ios:cloud:sim
bun run --cwd packages/app test:e2e:ios:onboarding
bun run --cwd packages/app capture:ios-sim:attachment
bun run --cwd packages/app test:sim:local-chat:ios -- --start-host-agent
lsof -i :31338
```

## Evidence applicability

- Real LLM trajectory: N/A. This change only moves deterministic test host-agent orchestration into scripts.
- Frontend screenshots/video: blocked locally by missing full Xcode/simctl; required on the runner before closing the issue.
- Backend logs: `host-agent-node23-failure.txt` shows the helper wrote and surfaced the actual child log. Successful real `serve-real-local-agent.ts` logs require Node 24+.
- Domain artifacts: `host-agent.log` is produced in each lane artifact directory; local generated `.log` is ignored by repo policy, so the relevant failure text is preserved in `host-agent-node23-failure.txt`.
