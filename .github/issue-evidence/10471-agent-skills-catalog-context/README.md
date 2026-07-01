# Issue #10471 - agent skills catalog provider gate

## Change

- Branch: `fix/10471-agent-skills-catalog-context`
- Removed the raw English capability phrase gate from `agent_skills_catalog`.
- Provider visibility now relies on the existing structured provider metadata:
  `contexts: ["agent_internal", "settings"]` and `contextGate`.
- Added regression coverage proving selected catalog context returns catalog
  categories for non-English user text.

## Validation

- `bun run --cwd plugins/plugin-agent-skills test -- providers/skills.test.ts`
  - PASS, see `focused-provider-test.log`
- `bun run --cwd plugins/plugin-agent-skills test`
  - PASS, see `full-plugin-agent-skills-test.log`
- `bun run --cwd plugins/plugin-agent-skills typecheck`
  - PASS, see `typecheck.log`
- `bun run --cwd plugins/plugin-agent-skills lint:check`
  - PASS, see `lint-check.log`
- `bun run --cwd plugins/plugin-agent-skills build`
  - PASS, see `build.log`
- `bun install`
  - PASS, see `install.log`
- `PATH="/Users/shawwalters/.bun/bin:$PATH" bun run verify`
  - PASS, see `root-verify.log`

## Evidence Gaps / N/A

- Live model trajectory: N/A. This change removes a deterministic provider
  post-selection gate; no model behavior changed.
- Screenshots/video/audio: N/A. No UI, visual, or audio surface changed.
