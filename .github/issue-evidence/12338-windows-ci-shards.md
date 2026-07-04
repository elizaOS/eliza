# #12338 Windows CI shard consolidation evidence

## Static change

- `.github/workflows/windows-ci.yml` now runs 5 Windows shards instead of the previous 19 one-command matrix lanes.
- The existing Windows command coverage is preserved as shard commands:
  - `typecheck-core`
  - `test-core`
  - `test-shared`
  - `test-app-core`
  - `test-elizaos-cli`
  - `test-cloud-shared`
  - `test-plugin-coding-tools`
  - `test-scenario-runner`
  - `test-vault`
  - `test-security`
  - `test-plugin-elizacloud`
  - `test-plugin-discord`
  - `test-plugin-anthropic`
  - `test-plugin-openai`
  - `test-plugin-app-control`
  - `test-plugin-task-coordinator`
  - `test-plugin-browser`
  - `build-agent-cascade`
  - `verify-riscv64-buildpaths`
  - `run-python --version`
  - `test-cloud-run`
  - `clean-stray-dts`
- The workflow paths filter now includes every package/plugin directory directly exercised by the Windows shard commands.
- `packages/scripts/__tests__/windows-ci-workflow.test.ts` now fails if the shard lane set changes accidentally or if any pre-shard Windows command is dropped or duplicated.

## Local verification

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/windows-ci.yml"); puts "yaml ok"'
actionlint .github/workflows/windows-ci.yml
rg -n "^\\s*- (node packages/scripts|bun run --cwd)" .github/workflows/windows-ci.yml
bun test packages/scripts/__tests__/windows-ci-workflow.test.ts
```

## Post-PR evidence still required

- A before/after `gh run view <id> --json jobs` timing comparison from real Windows CI runs.
- Confirmation that the new 5-shard run reduces Windows billable minutes by at least 40 percent against the #12337 baseline.
