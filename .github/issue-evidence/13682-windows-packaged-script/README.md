# Issue #13682 evidence

Verified on macOS (`process.platform === "darwin"`) that the
`test:desktop:packaged:windows` lane resolves from the repo root and fails
non-zero on the truthful Windows-host precondition instead of Bun's old
`Script not found` failure.

Artifacts:

- `focused-vitest.log` - focused guard for the root/app script definitions,
  canonical call sites, launcher-path handoff contract, macOS precondition
  failure, and distinct macOS/Windows packaged lanes.
- `root-command-nonwindows.log` - actual `bun run
  test:desktop:packaged:windows` invocation from repo root. Expected exit code
  is `1` on macOS with `requires a windows host`; no `Script not found`.
- `canonical-call-sites.log` - grep showing the workflow, release check,
  regression matrix, root script, and app script all reference the canonical
  lane.

N/A:

- Screenshots/video - no UI surface changed.
- Frontend logs - no browser/client path changed.
- Live LLM trajectory - no model/action/provider/prompt behavior changed.
- Domain artifacts - no memory, DB, wallet, scheduled-task, or generated user
  artifact path changed.
