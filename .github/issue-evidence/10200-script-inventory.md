# Root `package.json` script inventory — issue #10200 (AC-1)

> Read-only analysis + committed report. **No scripts are removed in this PR.**
> Removal is a deliberate follow-up; this inventory is its evidence base.

## Method

- Source of truth: the root `package.json` `scripts` block at commit `766a43d62eb`
  (origin/develop). **204 scripts** total.
- **Active-caller analysis** combines three independent passes:
  1. The repo's own reachability classifier
     (`packages/scripts/audit-scripts-inventory.mjs`, the tool shipped for the
     sibling issue #10194) — builds the root-script call graph seeded from
     `verify` / `test` / `build` + every `.github/workflows/**` reference, then
     marks each root script `reachable-from-{verify,test,build,ci-workflow}` or
     `orphan`. It reports **69 reachable / 135 orphan** roots.
  2. An independent grep of every caller surface for `\brun[:\s]+<name>` —
     `.github/workflows/**` (144 workflow files), **every** `package.json` in the
     repo, all `*.md` docs, and `scripts/**` + `packages/scripts/**` source — to
     find who actually invokes each name. (`CI=` = workflow, `doc=` = markdown,
     `code=` = script source, `rootSelf=` = another root script, `pkg:` = a
     sub-package script — `pkg:` hits for generic names like `build`/`test`/`dev`
     are local `--cwd` scripts, i.e. **not** root-script callers, and are
     filtered out of the evidence column below.)
  3. **Target verification**: every `--cwd <dir>`, `--filter=@elizaos/<pkg>` /
     `--filter=./<path>`, and `node|bun <file>` argument was resolved against the
     working tree. **Result: every target resolves — no root script points at a
     deleted file, directory, or workspace.** (The CLAUDE.md repo map is stale —
     cloud now lives at nested `packages/cloud/{api,shared,sdk,routing,...}`, and
     the `--cwd packages/cloud/*` references are valid against that layout.)

## Classification key

- **ACTIVE** — invoked by CI, by `verify`/`test`/`build`, or transitively by a
  script in those chains (reachable in the call graph, or a direct `CI=` hit).
- **ALIAS** — thin wrapper whose body is only `bun run <other-root-script>`
  (compat/convenience alias). Target noted.
- **DEV-ENTRY** — a human/maintainer runs it directly (dev / start / build:* /
  test:* / verify / release / version / publish / bench / voice / db / clean /
  migrate / smartglasses …). Its tool exists; nothing else needs to "call" it.
- **STALE-CANDIDATE** — **zero real callers AND an exact duplicate of another
  script** (no broken-target cases exist — all targets resolve). Conservative:
  anything that might be a human entrypoint is left DEV-ENTRY, not stale.

## Summary counts

| metric | count |
|---|---|
| **Total root scripts** | **204** |
| ACTIVE | 69 |
| DEV-ENTRY | 128 |
| ALIAS | 4 |
| STALE-CANDIDATE | 3 |

### Per group

| group | scripts | ACTIVE | ALIAS | DEV-ENTRY | STALE |
|---|---|---|---|---|---|
| Build | 9 | 5 | 0 | 4 | 0 |
| Typecheck / lint / verify | 17 | 9 | 1 | 7 | 0 |
| Test | 53 | 30 | 1 | 22 | 0 |
| Audit | 18 | 7 | 0 | 11 | 0 |
| App / mobile / capture | 29 | 6 | 0 | 23 | 0 |
| Cloud | 24 | 7 | 2 | 14 | 1 |
| Benchmarks | 13 | 1 | 0 | 12 | 0 |
| Release / publish | 15 | 1 | 0 | 14 | 0 |
| Dev / start | 14 | 1 | 0 | 11 | 2 |
| Clean | 2 | 0 | 0 | 2 | 0 |
| Misc | 10 | 2 | 0 | 8 | 0 |
| **Total** | **204** | **69** | **4** | **128** | **3** |

## Per-group inventory

### Build (9 scripts — ACTIVE 5, DEV-ENTRY 4)

| script | purpose | class | callers / evidence |
|---|---|---|---|
| `build` | `node packages/scripts/run-turbo.mjs run build --concurrency=8 --fil...` | ACTIVE | doc=70,CI=18,code=38,rootSelf=6; reach=build-chain |
| `build:client` | `node packages/scripts/run-turbo.mjs run build --filter=@elizaos/app` | DEV-ENTRY | code=1 |
| `build:core` | `node packages/scripts/run-turbo.mjs run build --filter=@elizaos/con...` | ACTIVE | CI=6,rootSelf=3; reach=CI-workflow |
| `build:server` | `node packages/scripts/run-turbo.mjs run build --filter=@elizaos/agent` | DEV-ENTRY | NONE |
| `build:typescript` | `node packages/scripts/run-turbo.mjs run build` | DEV-ENTRY | NONE |
| `build:views` | `node packages/scripts/build-views.mjs` | ACTIVE | CI=1; reach=CI-workflow |
| `check:view-bundles` | `bun packages/scripts/view-bundle-import-guard.mjs` | ACTIVE | rootSelf=1; reach=build-chain |
| `dev:prepare` | `node packages/scripts/run-turbo.mjs run build --filter=@elizaos/app...` | ACTIVE | CI=1; reach=CI-workflow |
| `dev:views` | `node packages/scripts/dev-views.mjs` | DEV-ENTRY | NONE |

### Typecheck / lint / verify (17 scripts — ACTIVE 9, ALIAS 1, DEV-ENTRY 7)

| script | purpose | class | callers / evidence |
|---|---|---|---|
| `audit:build-model` | `node packages/scripts/audit-build-typecheck.mjs` | ACTIVE | rootSelf=1; reach=verify-chain |
| `audit:scripts` | `node packages/scripts/audit-scripts.mjs` | ACTIVE | rootSelf=1; reach=verify-chain |
| `audit:scripts:inventory` | `node packages/scripts/audit-scripts-inventory.mjs` | DEV-ENTRY | NONE |
| `audit:scripts:self-test` | `node packages/scripts/audit-scripts.self-test.mjs` | DEV-ENTRY | NONE |
| `audit:turbo-build-deps` | `node packages/scripts/audit-turbo-build-deps.mjs` | ACTIVE | rootSelf=1; reach=verify-chain |
| `check` | `bun run verify` | ACTIVE | doc=4; reach=verify-chain |
| `format` | `node packages/scripts/run-turbo.mjs run format` | DEV-ENTRY | doc=3 |
| `format:check` | `node packages/scripts/run-turbo.mjs run format:check` | ACTIVE | CI=3,code=1; reach=CI-workflow |
| `knip` | `NODE_OPTIONS='--max-old-space-size=16384' knip --no-progress --no-e...` | DEV-ENTRY | NONE |
| `knip:strict` | `NODE_OPTIONS='--max-old-space-size=16384' knip --no-progress` | DEV-ENTRY | NONE |
| `lint` | `node packages/scripts/run-turbo.mjs run lint && node packages/scrip...` | ACTIVE | CI=3,doc=13,code=2; reach=CI-workflow |
| `lint:all` | `bun run lint:check && bun run typecheck` | ALIAS | NONE |
| `lint:check` | `node packages/scripts/run-turbo.mjs run lint:check` | DEV-ENTRY | rootSelf=1 |
| `pre-commit` | `bun run packages/scripts/pre-commit-lint.js` | DEV-ENTRY | NONE |
| `typecheck` | `NODE_OPTIONS='--max-old-space-size=8192' node packages/scripts/run-...` | ACTIVE | doc=47,CI=5,code=4,rootSelf=2; reach=CI-workflow |
| `typecheck:dist` | `node packages/scripts/generate-dist-paths-config.mjs --check && nod...` | ACTIVE | rootSelf=1; reach=verify-chain |
| `verify` | `bun run audit:type-safety-ratchet && NODE_OPTIONS='--max-old-space-...` | ACTIVE | doc=17,rootSelf=1; reach=verify-chain |

### Test (53 scripts — ACTIVE 30, ALIAS 1, DEV-ENTRY 22)

| script | purpose | class | callers / evidence |
|---|---|---|---|
| `capability-router:fixture-server` | `bun packages/scripts/capability-router-fixture-server.ts` | DEV-ENTRY | doc=1 |
| `ensure-plugin-test-conventions` | `bun packages/scripts/ensure-plugin-test-conventions.mjs` | DEV-ENTRY | code=1 |
| `ensure-plugin-test-conventions:check` | `bun packages/scripts/ensure-plugin-test-conventions.mjs --check` | DEV-ENTRY | NONE |
| `test` | `node packages/scripts/run-all-tests.mjs --only=test --no-cloud` | ACTIVE | CI=4,doc=71,code=6,rootSelf=1; reach=test-chain |
| `test:all` | `node packages/scripts/run-all-tests.mjs --all` | DEV-ENTRY | NONE |
| `test:apple-entitlements` | `bun run --cwd packages/app-core test:apple-entitlements` | ACTIVE | rootSelf=1; reach=CI-workflow |
| `test:browser-bridge` | `cd packages/browser-extension && bun run test:ci` | DEV-ENTRY | NONE |
| `test:browser-bridge:safari` | `cd packages/browser-extension && bun run test:smoke:safari` | DEV-ENTRY | NONE |
| `test:cache-stability` | `node packages/scripts/run-vitest.mjs run packages/core/src/runtime/...` | ACTIVE | CI=1; reach=CI-workflow |
| `test:ci` | `TEST_LANE=pr node packages/scripts/run-all-tests.mjs --only=test --...` | DEV-ENTRY | rootSelf=1 |
| `test:ci:live` | `TEST_LANE=post-merge node packages/scripts/run-all-tests.mjs --all ...` | DEV-ENTRY | NONE |
| `test:client` | `bun run build:core && TEST_PACKAGE_FILTER='\((packages/app\|package...` | ACTIVE | CI=1,doc=2; reach=CI-workflow |
| `test:core` | `node packages/scripts/with-test-runtime.mjs node packages/scripts/r...` | ACTIVE | CI=1; reach=CI-workflow |
| `test:dev-startup` | `node packages/app-core/scripts/dev-startup-smoke.mjs` | ACTIVE | CI=1; reach=CI-workflow |
| `test:e2e` | `TEST_LANE=pr node packages/scripts/run-all-tests.mjs --only=e2e --n...` | ACTIVE | CI=4,doc=13,code=3; reach=CI-workflow |
| `test:e2e:audit-ui` | `node scripts/e2e-recordings/audit-ui-coverage.mjs` | DEV-ENTRY | doc=1 |
| `test:e2e:heavy` | `TEST_LANE=post-merge bunx vitest run --config packages/test/vitest/...` | ACTIVE | CI=1,code=1; reach=CI-workflow |
| `test:e2e:live` | `TEST_LANE=post-merge node packages/scripts/run-all-tests.mjs --only...` | DEV-ENTRY | NONE |
| `test:e2e:record` | `node scripts/e2e-recordings/run-all.mjs` | DEV-ENTRY | doc=3 |
| `test:e2e:record:sheets` | `node scripts/e2e-recordings/generate-contact-sheets.mjs && node scr...` | DEV-ENTRY | doc=1 |
| `test:hmr` | `bun run --cwd packages/app test:hmr` | ACTIVE | CI=1; reach=CI-workflow |
| `test:launch-qa` | `bun test packages/scripts/launch-qa/*.test.ts && bun run test:launc...` | ACTIVE | CI=1; reach=CI-workflow |
| `test:launch-qa:docs` | `node packages/scripts/launch-qa/check-docs.mjs --scope=launchdocs -...` | ACTIVE | rootSelf=1; reach=CI-workflow |
| `test:launch-qa:release:dry` | `node packages/scripts/launch-qa/run.mjs --suite release --dry-run` | DEV-ENTRY | NONE |
| `test:lifeops` | `node packages/scripts/run-all-tests.mjs --filter=plugins/plugin-per...` | DEV-ENTRY | NONE |
| `test:lint` | `bun run test:lint:no-vi-mocks && bun run test:lint:lane-coverage` | ALIAS | NONE |
| `test:lint:lane-coverage` | `node packages/scripts/lint-lane-coverage.mjs` | DEV-ENTRY | rootSelf=1 |
| `test:lint:no-vi-mocks` | `node packages/scripts/lint-no-vi-mocks.mjs` | DEV-ENTRY | rootSelf=1 |
| `test:plugin` | `node packages/scripts/run-all-tests.mjs --only=e2e --pattern` | DEV-ENTRY | NONE |
| `test:plugins` | `bun run build:core && TEST_PACKAGE_FILTER='\(plugins/' TEST_SCRIPT_...` | ACTIVE | CI=2; reach=CI-workflow |
| `test:regression-matrix:release` | `node packages/app-core/scripts/run-eliza-app-core-script.mjs valida...` | ACTIVE | CI=1,code=1; reach=CI-workflow |
| `test:regression-matrix:release-contract` | `node packages/app-core/scripts/run-eliza-app-core-script.mjs valida...` | ACTIVE | CI=1,code=1; reach=CI-workflow |
| `test:release:contract` | `bun run audit:apple-store-sandbox && bun run test:apple-entitlement...` | ACTIVE | CI=1,code=1; reach=CI-workflow |
| `test:remote-capabilities` | `bun run --cwd packages/agent test:remote-capabilities` | ACTIVE | CI=1,doc=1; reach=CI-workflow |
| `test:remote-capabilities:docker` | `bun run --cwd packages/agent test:remote-capabilities:docker` | ACTIVE | CI=1,doc=1; reach=CI-workflow |
| `test:remote-capabilities:fixture-server` | `bun packages/scripts/capability-router-fixture-conformance-smoke.ts` | ACTIVE | CI=1; reach=CI-workflow |
| `test:remote-capabilities:github-live-artifacts` | `bun packages/scripts/validate-capability-router-github-live-artifac...` | DEV-ENTRY | doc=1 |
| `test:remote-capabilities:github-live-artifacts:self-test` | `bun packages/scripts/validate-capability-router-github-live-artifac...` | ACTIVE | CI=1; reach=CI-workflow |
| `test:remote-capabilities:github-live-evidence` | `bun packages/scripts/validate-capability-router-github-live-evidenc...` | DEV-ENTRY | doc=1 |
| `test:remote-capabilities:github-live-evidence:self-test` | `bun packages/scripts/validate-capability-router-github-live-evidenc...` | ACTIVE | CI=1; reach=CI-workflow |
| `test:remote-capabilities:live-ci-audit` | `bun packages/scripts/audit-capability-router-live-ci.ts` | ACTIVE | CI=1; reach=CI-workflow |
| `test:remote-capabilities:live-ci-audit:self-test` | `bun packages/scripts/audit-capability-router-live-ci.self-test.ts` | ACTIVE | CI=1; reach=CI-workflow |
| `test:remote-capabilities:naming-audit` | `bun packages/scripts/audit-capability-router-naming.ts` | ACTIVE | CI=1; reach=CI-workflow |
| `test:remote-capabilities:naming-audit:self-test` | `bun packages/scripts/audit-capability-router-naming.self-test.ts` | ACTIVE | CI=1; reach=CI-workflow |
| `test:remote-capabilities:source-build` | `bun run --cwd packages/agent test:remote-capabilities:source-build` | ACTIVE | CI=1,doc=1; reach=CI-workflow |
| `test:remote-capabilities:surface-audit` | `bun packages/scripts/audit-capability-router-plugin-surface.ts` | ACTIVE | CI=1; reach=CI-workflow |
| `test:remote-capabilities:ui` | `bun run --cwd packages/app test:remote-capabilities:ui` | ACTIVE | CI=1,doc=1; reach=CI-workflow |
| `test:remote-capabilities:validate-live-reports` | `bun packages/scripts/validate-capability-router-live-reports.ts` | ACTIVE | CI=1,doc=1; reach=CI-workflow |
| `test:remote-capabilities:validate-live-reports:self-test` | `bun packages/scripts/validate-capability-router-live-reports.self-t...` | ACTIVE | CI=1; reach=CI-workflow |
| `test:server` | `bun run build:core && TEST_PACKAGE_FILTER='\((packages/agent\|packa...` | ACTIVE | CI=1,doc=2; reach=CI-workflow |
| `test:ui:playwright` | `bun run --cwd packages/app test:e2e` | DEV-ENTRY | NONE; DUP of test:cloud:playwright |
| `trajectory:inspect` | `bun packages/scripts/trajectory.ts` | DEV-ENTRY | NONE |
| `trajectory:inspect:test` | `bun test packages/scripts/__tests__/trajectory-validate.test.ts` | DEV-ENTRY | NONE |

### Audit (18 scripts — ACTIVE 7, DEV-ENTRY 11)

| script | purpose | class | callers / evidence |
|---|---|---|---|
| `audit:apple-store-sandbox` | `bun run --cwd packages/app-core audit:apple-store-sandbox` | ACTIVE | rootSelf=1; reach=CI-workflow |
| `audit:e2e-coverage` | `bun packages/scripts/e2e-coverage/check-e2e-coverage.ts` | DEV-ENTRY | doc=1 |
| `audit:e2e-coverage:test` | `bun test packages/scripts/e2e-coverage/check-e2e-coverage.test.ts` | DEV-ENTRY | doc=1 |
| `audit:even-research` | `node scripts/check-even-research-audit.mjs` | DEV-ENTRY | doc=1 |
| `audit:even-research:self-test` | `node scripts/check-even-research-audit.mjs --self-test` | DEV-ENTRY | doc=1 |
| `audit:smartglasses-completion` | `node scripts/check-smartglasses-completion-gate.mjs` | DEV-ENTRY | doc=1 |
| `audit:smartglasses-completion:self-test` | `node scripts/check-smartglasses-completion-gate.mjs --self-test` | DEV-ENTRY | doc=1 |
| `audit:tee-secret-leak` | `node packages/scripts/audit-tee-secret-leak.mjs` | ACTIVE | rootSelf=1; reach=verify-chain |
| `audit:tee-secret-leak:self-test` | `node packages/scripts/audit-tee-secret-leak.mjs --self-test` | DEV-ENTRY | NONE |
| `audit:type-duplication` | `node packages/scripts/type-duplication-audit.mjs` | DEV-ENTRY | doc=1 |
| `audit:type-duplication:check` | `node packages/scripts/type-duplication-audit.mjs --check` | DEV-ENTRY | doc=1 |
| `audit:type-duplication:self-test` | `node packages/scripts/type-duplication-audit.mjs --self-test` | ACTIVE | CI=2,doc=1; reach=CI-workflow |
| `audit:type-duplication:update-baseline` | `node packages/scripts/type-duplication-audit.mjs --update-baseline` | DEV-ENTRY | doc=1 |
| `audit:type-safety-ratchet` | `node packages/scripts/type-safety-ratchet.mjs` | ACTIVE | doc=1,CI=3,rootSelf=1; reach=verify-chain |
| `audit:type-safety-ratchet:self-test` | `node packages/scripts/type-safety-ratchet.mjs --self-test` | ACTIVE | CI=3; reach=CI-workflow |
| `audit:ui-determinism` | `node packages/scripts/audit-ui-determinism.mjs` | ACTIVE | CI=2; reach=CI-workflow |
| `audit:ui-determinism:self-test` | `node packages/scripts/audit-ui-determinism.mjs --self-test` | ACTIVE | CI=2; reach=CI-workflow |
| `audit:ui-determinism:update` | `node packages/scripts/audit-ui-determinism.mjs --update-baseline` | DEV-ENTRY | NONE |

### App / mobile / capture (29 scripts — ACTIVE 6, DEV-ENTRY 23)

| script | purpose | class | callers / evidence |
|---|---|---|---|
| `ai-qa:review` | `node scripts/ai-qa/review-screenshots.mjs` | DEV-ENTRY | NONE |
| `browser-bridge:package:release` | `cd packages/browser-extension && bun run package:release` | ACTIVE | code=1; reach=CI-workflow |
| `build:android:cloud` | `node packages/app-core/scripts/run-mobile-build.mjs android-cloud` | ACTIVE | CI=1,doc=1; reach=CI-workflow |
| `build:android:system` | `node packages/app-core/scripts/run-mobile-build.mjs android-system` | DEV-ENTRY | doc=1 |
| `build:riscv64-artifacts` | `node packages/scripts/run-bash-linux-only.mjs scripts/build-riscv64...` | ACTIVE | CI=1,doc=1,code=1; reach=CI-workflow |
| `check:riscv64-artifacts` | `node packages/scripts/run-bash-linux-only.mjs scripts/check-riscv64...` | ACTIVE | CI=1,doc=1,code=1; reach=CI-workflow |
| `generate:action-search-keywords` | `node packages/scripts/generate-action-search-keywords.mjs && node p...` | ACTIVE | CI=1; reach=CI-workflow |
| `local-inference:ablation` | `node plugins/plugin-local-inference/scripts/local-inference-ablatio...` | DEV-ENTRY | NONE |
| `local-inference:ablation:quick` | `node plugins/plugin-local-inference/scripts/local-inference-ablatio...` | DEV-ENTRY | NONE |
| `smartglasses:dev:hardware` | `bun run --cwd packages/examples/smartglasses dev:hardware` | DEV-ENTRY | doc=3,code=1 |
| `smartglasses:dev:simulator` | `bun run --cwd packages/examples/smartglasses dev:simulator` | DEV-ENTRY | doc=2,code=1 |
| `smartglasses:hardware:doctor` | `bun run --cwd packages/examples/smartglasses hardware:doctor` | DEV-ENTRY | doc=1,code=1 |
| `smartglasses:hardware:prove` | `bun run --cwd packages/examples/smartglasses hardware:prove:bleak` | DEV-ENTRY | doc=3,code=1 |
| `smartglasses:hardware:prove:noble` | `bun run --cwd packages/examples/smartglasses hardware:prove:noble` | DEV-ENTRY | doc=4,code=1 |
| `smartglasses:hardware:prove:noble:watch` | `bun run --cwd packages/examples/smartglasses hardware:prove:noble:w...` | DEV-ENTRY | doc=3,code=1 |
| `smartglasses:hardware:prove:watch` | `bun run --cwd packages/examples/smartglasses hardware:prove:bleak:w...` | DEV-ENTRY | doc=4,code=1 |
| `smartglasses:hardware:status` | `bun run --cwd packages/examples/smartglasses hardware:status-latest` | DEV-ENTRY | doc=3,code=1 |
| `smartglasses:hardware:validate` | `bun run --cwd packages/examples/smartglasses hardware:validate-latest` | DEV-ENTRY | doc=4,code=1 |
| `smartglasses:simulator` | `bun run --cwd packages/examples/smartglasses simulator` | DEV-ENTRY | doc=2,code=1 |
| `smartglasses:smoke:simulator` | `bun run --cwd packages/examples/smartglasses smoke:simulator` | DEV-ENTRY | doc=2,code=1 |
| `verify:riscv64` | `node packages/scripts/run-bash-linux-only.mjs scripts/verify-riscv6...` | DEV-ENTRY | doc=1 |
| `verify:riscv64:e2e` | `node packages/scripts/run-bash-linux-only.mjs scripts/verify-riscv6...` | DEV-ENTRY | doc=1 |
| `verify:smartglasses-software` | `node scripts/verify-smartglasses-software.mjs` | DEV-ENTRY | doc=2,code=1 |
| `voice-models:publish-all` | `node packages/scripts/voice-models-publish-all.mjs` | DEV-ENTRY | code=1 |
| `voice:create-profile` | `bun packages/app-core/scripts/voice-create-profile.mjs` | DEV-ENTRY | NONE |
| `voice:duet` | `bun packages/app-core/scripts/voice-duet.mjs` | DEV-ENTRY | code=1 |
| `voice:interactive` | `bun packages/app-core/scripts/voice-interactive.mjs` | DEV-ENTRY | code=1 |
| `voice:latency-report` | `node packages/app-core/scripts/voice-latency-report.mjs` | DEV-ENTRY | NONE |
| `voice:matrix` | `node packages/scripts/voice-matrix.mjs` | ACTIVE | CI=1,doc=1; reach=CI-workflow |

### Cloud (24 scripts — ACTIVE 7, ALIAS 2, DEV-ENTRY 14, STALE-CANDIDATE 1)

| script | purpose | class | callers / evidence |
|---|---|---|---|
| `build:cloud` | `bun run --cwd packages/cloud/api build` | DEV-ENTRY | NONE |
| `cloud:e2e` | `bun run --cwd packages/test/cloud-e2e test` | ACTIVE | doc=8,CI=2; reach=CI-workflow |
| `cloud:e2e:headed` | `bun run --cwd packages/test/cloud-e2e test:headed` | DEV-ENTRY | doc=3 |
| `cloud:e2e:ui` | `bun run --cwd packages/test/cloud-e2e test:ui` | DEV-ENTRY | doc=3 |
| `cloud:login:test-wallet` | `bun scripts/cloud/siwe-test-login.mjs` | DEV-ENTRY | doc=4,code=1 |
| `cloud:mock` | `bun scripts/cloud/mock-stack-up.mjs` | DEV-ENTRY | doc=6 |
| `cloud:mock:fresh` | `bun scripts/cloud/mock-stack-up.mjs --reset` | DEV-ENTRY | NONE |
| `db:cloud:generate` | `bun run --cwd packages/cloud/shared db:generate` | DEV-ENTRY | NONE |
| `db:cloud:migrate` | `bun --conditions=eliza-source packages/scripts/cloud/admin/migrate-...` | ACTIVE | CI=1; reach=CI-workflow |
| `db:cloud:pglite` | `bun run packages/scripts/cloud/admin/dev/pglite-server.ts` | DEV-ENTRY | NONE |
| `db:cloud:studio` | `bun run --cwd packages/cloud/shared db:studio` | DEV-ENTRY | NONE |
| `dev:cloud` | `concurrently -n api,web -c blue,magenta "bun run dev:cloud:api" "bu...` | DEV-ENTRY | rootSelf=1 |
| `dev:cloud:api` | `bun run --cwd packages/cloud/api dev` | DEV-ENTRY | rootSelf=1 |
| `dev:cloud:full` | `bun run dev:cloud` | ALIAS | NONE |
| `dev:cloud:web` | `bun run --cwd packages/app dev` | DEV-ENTRY | rootSelf=1 |
| `eliza1:cost-reconciliation` | `bun run packages/scripts/cloud/eliza1/cost-reconciliation.ts` | DEV-ENTRY | NONE |
| `eliza1:dashboard-alerts` | `bun run packages/scripts/cloud/eliza1/dashboard-alerts.ts` | DEV-ENTRY | NONE |
| `test:cloud` | `node packages/scripts/test-cloud-run.mjs` | ACTIVE | CI=1,rootSelf=1; reach=CI-workflow |
| `test:cloud:e2e` | `bun run --cwd packages/cloud/api test:e2e` | ACTIVE | CI=1,rootSelf=1; reach=CI-workflow |
| `test:cloud:full` | `bun run test:cloud && bun run test:cloud:e2e` | ALIAS | NONE |
| `test:cloud:integration` | `node packages/scripts/cloud/admin/run-integration-tests.mjs` | ACTIVE | CI=1; reach=CI-workflow |
| `test:cloud:playwright` | `bun run --cwd packages/app test:e2e` | STALE-CANDIDATE | NONE; DUP of test:ui:playwright |
| `typecheck:cloud` | `bun run --cwd packages/cloud/shared typecheck && bun run --cwd pack...` | ACTIVE | rootSelf=1; reach=CI-workflow |
| `verify:cloud` | `bun run --cwd packages/cloud/shared lint && bun run typecheck:cloud` | ACTIVE | CI=1; reach=CI-workflow |

### Benchmarks (13 scripts — ACTIVE 1, DEV-ENTRY 12)

| script | purpose | class | callers / evidence |
|---|---|---|---|
| `bench:eliza-1` | `bun run --cwd packages/benchmarks/eliza-1 start` | DEV-ENTRY | NONE |
| `bench:memperf` | `node packages/benchmarks/memperf/run-all.mjs` | DEV-ENTRY | doc=3 |
| `bench:memperf:json` | `node packages/benchmarks/memperf/run-all.mjs --json` | DEV-ENTRY | doc=3 |
| `bench:recall` | `bun run --cwd packages/benchmarks/recall-bench bench` | DEV-ENTRY | doc=1 |
| `bench:recall:1k` | `bun run --cwd packages/benchmarks/recall-bench bench:1k` | ACTIVE | doc=2,CI=1; reach=CI-workflow |
| `bench:three-agent` | `bun run --cwd packages/benchmarks/three-agent-dialogue bench` | DEV-ENTRY | NONE |
| `bench:three-agent:smoke` | `bun run --cwd packages/benchmarks/three-agent-dialogue bench:smoke` | DEV-ENTRY | NONE |
| `bench:voice-emotion-roundtrip` | `node packages/scripts/run-python.mjs -m pytest packages/benchmarks/...` | DEV-ENTRY | NONE |
| `bench:voice-speaker` | `node packages/scripts/run-python.mjs -m pytest packages/benchmarks/...` | DEV-ENTRY | NONE |
| `bench:voice-speaker:smoke` | `node packages/scripts/run-python.mjs -m pytest packages/benchmarks/...` | DEV-ENTRY | NONE |
| `lifeops:bench` | `bun --bun packages/app-core/scripts/lifeops-prompt-benchmark.ts` | DEV-ENTRY | NONE |
| `personality:bench:calibrate` | `bun --filter @elizaos/personality-bench calibrate` | DEV-ENTRY | NONE |
| `personality:judge` | `bun --bun packages/benchmarks/personality-bench/src/runner.ts` | DEV-ENTRY | doc=2 |

### Release / publish (15 scripts — ACTIVE 1, DEV-ENTRY 14)

| script | purpose | class | callers / evidence |
|---|---|---|---|
| `postpublish:restore` | `node packages/scripts/restore-workspace-refs.js` | DEV-ENTRY | NONE |
| `prepublish:versions` | `node packages/scripts/replace-workspace-versions.js` | DEV-ENTRY | NONE |
| `publish:dry-run` | `bun packages/scripts/publish-from-dist.mjs` | DEV-ENTRY | NONE |
| `publish:eliza1` | `cd packages/training && node ../scripts/run-python.mjs -m scripts.p...` | DEV-ENTRY | NONE |
| `publish:eliza1:dry-run` | `cd packages/training && node ../scripts/run-python.mjs -m scripts.p...` | DEV-ENTRY | NONE |
| `publish:packages` | `bun packages/scripts/publish-from-dist.mjs --apply` | DEV-ENTRY | NONE |
| `release` | `bunx lerna publish from-package --dist-tag latest --force-publish -...` | DEV-ENTRY | NONE |
| `release:beta` | `bunx lerna publish from-package --dist-tag beta --force-publish --y...` | DEV-ENTRY | NONE |
| `release:check` | `node packages/app-core/scripts/run-release-check.mjs` | ACTIVE | CI=1,code=1; reach=CI-workflow |
| `release:next` | `bunx lerna publish from-package --dist-tag next --force-publish --y...` | DEV-ENTRY | NONE |
| `soc2:verify` | `bun run packages/security/soc2-verify/src/cli.ts` | DEV-ENTRY | NONE |
| `version:beta` | `bunx lerna version prerelease --preid beta --force-publish --yes --...` | DEV-ENTRY | NONE |
| `version:major` | `bunx lerna version major --force-publish --yes --no-push --no-git-t...` | DEV-ENTRY | NONE |
| `version:minor` | `bunx lerna version minor --force-publish --yes --no-push --no-git-t...` | DEV-ENTRY | NONE |
| `version:patch` | `bunx lerna version patch --force-publish --yes --no-push --no-git-t...` | DEV-ENTRY | NONE |

### Dev / start (14 scripts — ACTIVE 1, DEV-ENTRY 11, STALE-CANDIDATE 2)

| script | purpose | class | callers / evidence |
|---|---|---|---|
| `dev` | `ELIZA_DEV_SOURCE=1 bun --conditions=eliza-source packages/app-core/...` | ACTIVE | CI=2,doc=53,code=15; reach=CI-workflow; DUP of dev:web:ui |
| `dev:agent` | `bun run --cwd packages/agent dev` | DEV-ENTRY | NONE |
| `dev:all` | `node packages/scripts/dev-all.mjs` | DEV-ENTRY | NONE |
| `dev:core` | `bun run --cwd packages/core dev` | DEV-ENTRY | NONE |
| `dev:desktop` | `ELIZA_DEV_SOURCE=1 ELIZA_NAMESPACE=eliza bun --conditions=eliza-sou...` | DEV-ENTRY | doc=6,code=3 |
| `dev:desktop:watch` | `ELIZA_DEV_SOURCE=1 ELIZA_NAMESPACE=eliza ELIZA_DESKTOP_VITE_WATCH=1...` | DEV-ENTRY | code=1 |
| `dev:harness` | `bun packages/scripts/dev-harness.mjs` | DEV-ENTRY | NONE |
| `dev:mocks` | `node packages/scripts/start-mocks-bg.mjs` | DEV-ENTRY | NONE |
| `dev:ui` | `ELIZA_DEV_SOURCE=1 bun --conditions=eliza-source packages/app-core/...` | DEV-ENTRY | NONE |
| `dev:web:ui` | `ELIZA_DEV_SOURCE=1 bun --conditions=eliza-source packages/app-core/...` | STALE-CANDIDATE | NONE; DUP of dev |
| `harness` | `bun run --cwd packages/agent start` | STALE-CANDIDATE | doc=2; DUP of start |
| `start` | `bun run --cwd packages/agent start` | DEV-ENTRY | doc=30; DUP of harness |
| `start:debug` | `NODE_NO_WARNINGS=1 LOG_LEVEL=debug bun run --cwd packages/agent start` | DEV-ENTRY | NONE |
| `start:eliza` | `node packages/app-core/scripts/run-node-tsx.mjs packages/app-core/s...` | DEV-ENTRY | NONE |

### Clean (2 scripts — DEV-ENTRY 2)

| script | purpose | class | callers / evidence |
|---|---|---|---|
| `cache:prune` | `node packages/scripts/prune-turbo-cache.mjs` | DEV-ENTRY | NONE |
| `clean` | `node packages/scripts/run-turbo.mjs run clean --concurrency=100% &&...` | DEV-ENTRY | doc=4,code=2 |

### Misc (10 scripts — ACTIVE 2, DEV-ENTRY 8)

| script | purpose | class | callers / evidence |
|---|---|---|---|
| `fix-deps` | `bun packages/scripts/fix-workspace-deps.mjs` | DEV-ENTRY | NONE |
| `fix-deps:check` | `bun packages/scripts/fix-workspace-deps.mjs --check` | DEV-ENTRY | NONE |
| `fix-deps:restore` | `bun packages/scripts/fix-workspace-deps.mjs --restore` | DEV-ENTRY | NONE |
| `install:light` | `ELIZA_SKIP_ARTIFACT_SYNC=1 bun install` | DEV-ENTRY | doc=3 |
| `lifeops:verify-cerebras` | `bun --bun plugins/plugin-personal-assistant/scripts/verify-cerebras...` | ACTIVE | CI=1; reach=CI-workflow |
| `migrate` | `node packages/scripts/run-turbo.mjs run migrate --filter=./plugins/...` | DEV-ENTRY | NONE |
| `migrate:generate` | `node packages/scripts/run-turbo.mjs run migrate:generate --filter=....` | DEV-ENTRY | NONE |
| `plugin-submodules:restore` | `bun packages/scripts/plugin-submodules-dev.mjs --restore` | DEV-ENTRY | NONE |
| `postinstall` | `bun packages/scripts/patch-nested-core-dist.mjs && bun packages/scr...` | ACTIVE | CI=1,code=1; reach=CI-workflow |
| `sync:artifacts` | `bun packages/scripts/sync-artifacts.mjs` | DEV-ENTRY | NONE |
---

## Duplicate-body candidates (with corrected, independently-verified evidence)

All three are exact byte-duplicates of a canonical script. **A second, independent
caller sweep (beyond name-grep) corrected the initial "zero callers" read — two of
the three are NOT safe to delete as-is.** This is the inventory's whole point:
proven removal requires a real caller search, not a name-grep, and a removal PR
must carry the migration note + update every dependent reference.

| script | duplicate of | corrected caller evidence | safe to remove? |
|---|---|---|---|
| `harness` | `start` (`bun run --cwd packages/agent start`) | No `bun run harness` caller. The earlier `doc=2` was a false positive (prose "dry-run harness"); the other `"harness"` hits across the repo are unrelated JSON config keys (voice-bench, chip docs), not script invocations. `start` is canonical (30 doc refs). | **YES** — a clean removal (migration note: use `start`). |
| `test:cloud:playwright` | `test:ui:playwright` (both `bun run --cwd packages/app test:e2e`) | **NOT zero-reference** — `packages/scenario-runner/src/scenario-pr-workflow.test.ts:616,619` asserts on `rootPackage.scripts["test:cloud:playwright"]` (`.toBe(...)` / `.not.toBe(...)`). Removing the script **fails that test**. | Only with the test updated — the `scenario-pr-workflow` assertion is a real dependent. Duplicate is real, but it's pinned. |
| `dev:web:ui` | `dev` (byte-identical body) | Beyond the one `desktop-local-development.md` alias cell, it is referenced as a documented run-command in `plugins/plugin-task-coordinator/vitest.e2e.config.ts:5` and `…/orchestrator-workbench.live.e2e.test.ts:9` ("run the stack with `bun run dev:web:ui`"). | Only after redirecting those e2e run-instructions + the doc cell to `dev`. It's a documented developer alias, not pure cruft. |

**Net:** exactly **one** script (`harness`) is removable on evidence alone; the other
two are genuine duplicates but have real dependents (a test assertion; e2e
run-instructions) that a removal PR must update first. The inventory's value here is
precisely that it surfaced those dependents that a name-grep missed.

> Note on `test:ui:playwright` (the surviving twin of `test:cloud:playwright`):
> kept as **DEV-ENTRY** — a documented developer command. The redundancy, if
> resolved, is by retiring the *cloud* twin (and updating the
> `scenario-pr-workflow` assertion), not this one.

### Needs-owner-confirmation (suspicious, but NOT proven stale)

Real signal, but each has a plausible human/maintainer use — do **not** delete
without an owner sign-off:

- **`test:lint` + `test:lint:no-vi-mocks` + `test:lint:lane-coverage`** — the
  whole chain is wired into **nothing**: no workflow and no `run-all-tests.mjs`
  reference invokes them; the only callers of the two leaf lints are `test:lint`
  itself, and `test:lint` has no external caller. The underlying tools exist
  (`lint-no-vi-mocks.mjs`, `lint-lane-coverage.mjs`; the latter even has a unit
  test). Decision for an owner: **wire these guards into CI** (they look intended
  to gate PRs) **or** delete the unenforced chain. Stale-ish, but it's a guard,
  not a duplicate — not auto-removable.
- **`dev:cloud:full`** (`bun run dev:cloud`), **`lint:all`**
  (`lint:check && typecheck`), **`test:cloud:full`** (`test:cloud && test:cloud:e2e`)
  — pure/composite ALIASes with zero callers; each is plausibly a convenience
  entrypoint a human types. `verify` supersedes `lint:all`. Consolidate only
  with owner OK.
- **`local-inference:ablation` / `:quick`** and **`lifeops:bench`** — zero
  *name* callers, but the underlying tools **are** exercised in CI by file
  path/test (`local-inference-matrix.yml` runs
  `node packages/scripts/local-inference-ablation.mjs` directly;
  `lifeops-prompt-benchmark.yml` runs the plugin vitest, not the root script).
  So the **root alias is dead weight while the tool is alive** — candidate to
  drop the root wrapper, keep the tool. Owner call.
- The `:self-test` / `:update(-baseline)` audit variants with no CI caller
  (`audit:scripts:self-test`, `audit:scripts:inventory`, `audit:tee-secret-leak:self-test`,
  `audit:ui-determinism:update`, `audit:type-duplication:{check,update-baseline}`,
  `audit:even-research:self-test`, `audit:smartglasses-completion:self-test`) —
  legitimate maintenance/self-test entrypoints whose tools exist. Several
  *should* run in CI but don't; that's a wiring gap, not a removal target.

## Structural smells (the issue's named targets, with evidence)

1. **`build:core` — a hand-maintained 27-package `--filter` allowlist.** A single
   `run-turbo run build` call carries **27** `--filter=@elizaos/…` flags
   (`contracts, core, shared, cloud-sdk, cloud-routing, cloud-shared, vault, ui,
   app-core, plugin-local-inference, plugin-training, plugin-ollama,
   plugin-commands, plugin-shell, plugin-coding-tools, plugin-agent-orchestrator,
   plugin-app-manager, plugin-wallet, plugin-video, plugin-background-runner,
   plugin-anthropic, plugin-openai, plugin-elizacloud, plugin-worker-runtime,
   plugin-x402, plugin-calendar, plugin-task-coordinator`). It is load-bearing —
   `test:plugins`, `test:client`, `test:server` all `bun run build:core` first,
   and 6 workflows call it — but the list is curated by hand: any new package a
   test lane needs must be appended manually, and a renamed/removed package would
   rot it silently. This is the prime de-larp target (derive the set from the
   dependency graph, e.g. `--filter=...^@elizaos/agent` or a generated list).

2. **`build` is a 3-stage composed chain.**
   `run-turbo run build --concurrency=8 --filter='!@elizaos/electrobun' --cache=local:r,remote:r --output-logs=errors-only`
   `&& bun run --cwd packages/app-core/platforms/electrobun build`
   `&& bun run check:view-bundles` — electrobun is excluded from the turbo pass
   then built separately, and a third guard is appended. Fine, but it means the
   real build graph is split across a filter-exclusion + a manual `--cwd` step.

3. **Three exact byte-duplicate pairs** (duplicate-body scan): `dev` ≡
   `dev:web:ui`, `start` ≡ `harness`, `test:ui:playwright` ≡ `test:cloud:playwright`.
   See proven-stale table.

4. **Variant-family inflation drives the ~204 count.** Thin parametrized
   wrappers dominate: `test:*` 53, `audit:*` (incl. lint) ~23, `smartglasses:*`
   11 (every one a `bun run --cwd packages/examples/smartglasses <x>` pass-through),
   `test:remote-capabilities:*` 16 (half of them `…:self-test` siblings),
   `bench:*` 10, `build:*` 10. Many `:check` / `:self-test` /
   `:update-baseline` / `:dry-run` / `:fresh` / `:quick` / `:json` / `:watch`
   siblings could collapse into a single script + a flag.

5. **Root aliases whose name nothing calls, while the tool runs in CI by file
   path** (smell, not breakage): `local-inference:ablation*`, `lifeops:bench`.
   The root entry adds a name to maintain with no caller.

6. **`prepublish:versions` / `postpublish:restore` are not lifecycle hooks.**
   Despite the `pre`/`post` prefix, npm/bun lifecycle fires `prepublish` /
   `postpublish`, **not** `prepublish:versions` / `postpublish:restore`. Nothing
   invokes them by name — they're manual release-ops steps wearing
   lifecycle-looking names (confusing, worth an owner note).

## Recommended next steps (for the decluttering follow-up)

**Safe to remove first (evidence-backed, low blast radius):**
1. `test:cloud:playwright` — zero references; exact dup of `test:ui:playwright`.
2. `dev:web:ui` — exact dup of `dev`; also update the one doc cell that names it.
3. `harness` — exact dup of `start`; no real caller.

**Do next, with a maintainer decision (per script above):**
- Resolve the `test:lint*` chain: **wire into CI** or delete (don't leave an
  unenforced guard).
- Collapse the pure ALIASes (`dev:cloud:full`, `lint:all`, `test:cloud:full`)
  into their targets if no one relies on them.
- Decide whether `local-inference:ablation*` / `lifeops:bench` root aliases earn
  their keep given CI invokes the tools by path.

**The real win (the issue's headline) — needs design, not just deletion:**
- Replace `build:core`'s hand-maintained 27-`--filter` list with a derived set
  (turbo dependency-graph filter or a generated allowlist), so test lanes stop
  depending on a manually-curated package roster.
- Consider folding the `:check` / `:self-test` / `:update-baseline` variant
  families into single scripts + flags to shrink the surface.

**Leave alone:** every `release:*` / `version:*` / `publish:*` / `db:cloud:*` /
`bench:*` / `voice:*` / `smartglasses:*` / `dev:*` entry — all are
maintainer/dev entrypoints with existing, valid targets. "No automated caller"
is expected for these and is **not** evidence of staleness.
