# 10096 Build Agent Image Turbo Contract

## Change

- Added `packages/scripts/__tests__/build-agent-image-workflow.test.ts` as a regression contract for `.github/workflows/build-agent-image.yml`.
- The test locks the Docker workspace artifact step to `node packages/scripts/run-turbo.mjs run build --filter=...` with the image's required app/agent/plugin filters.
- The test rejects a reintroduced package/plugin shell build loop in that artifact step.
- The test also confirms the remaining `plugins/*/dist` loop is only the post-build Node ESM rewrite step and runs after Turbo.

## Verification

- `node --check packages/scripts/__tests__/build-agent-image-workflow.test.ts`
- `bun test packages/scripts/__tests__/build-agent-image-workflow.test.ts`
- `gh run view 28356322785 --repo elizaOS/eliza --json status,conclusion,createdAt,headSha,headBranch,displayTitle,jobs,url`
- `gh run view 28356322785 --repo elizaOS/eliza --job 84000059543 --log | rg -n "run-turbo\\.mjs run build|Packages in scope|Normalize plugin dist|docker-ci-smoke|Boot verified|within budget"`

## GitHub Actions Evidence

- Workflow run: https://github.com/elizaOS/eliza/actions/runs/28356322785
- Job: https://github.com/elizaOS/eliza/actions/runs/28356322785/job/84000059543
- Run status: `completed`, conclusion: `success`, branch: `develop`, head SHA: `d21cec23b7d9f7eb1c08d352c4467821139debe1`.
- `Build Docker workspace artifacts` completed successfully from `2026-06-29T12:31:48Z` to `2026-06-29T12:36:47Z`.
- The run log shows the workflow executed `node packages/scripts/run-turbo.mjs run build --concurrency=8` with explicit filters including `@elizaos/app`, `@elizaos/agent`, `@elizaos/plugin-sql`, `@elizaos/plugin-elizacloud`, and `@elizaos/plugin-x402`.
- Turbo reported the complete package scope: `@elizaos/agent`, `@elizaos/app`, and the 24 filtered plugins.
- `Normalize plugin dist for Node ESM` completed successfully after the Turbo build and ran `packages/scripts/rewrite-dist-relative-imports-node-esm.mjs`.
- The Docker image build and real entrypoint gate also passed in the same job: `Verify image boots (real agent entrypoint)` reported `Boot verified: agent stayed up after health came up`, `cold readyMs=10451`, and `within budget (readyMs 10451 <= 25000)`.

## Not Covered

- This PR does not change the already-merged workflow behavior; it adds the missing regression guard/evidence for the #10096 `build-agent-image.yml` item.
