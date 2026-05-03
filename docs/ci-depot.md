# Depot CI — operating guide

Eliza uses [Depot](https://depot.dev) in two complementary roles:

1. **Docker image builds** (`.github/workflows/build-docker.yml`) — offloaded to
   Depot via `depot/build-push-action@v1`. Gives us a persistent cross-build
   layer cache, a proper BuildKit backend (vs the fragile GHA docker daemon),
   and push-directly-from-Depot to GHCR.
2. **Depot CI mirror workflows** (`.depot/workflows/`) — an auto-generated
   parallel copy of `.github/workflows/` that runs on Depot's own runner fleet.
   We **selectively** keep mirrors for compute-heavy workflows and **delete**
   mirrors for fast/auth-sensitive ones to avoid paying 2× CI cost.

Depot project ID: **`m89t0f0p08`** (`elizaAI`). Stored at `depot.json`.

---

## Configuration surface

| File | Purpose |
|---|---|
| `depot.json` | Depot project binding (`{ "id": "m89t0f0p08" }`) |
| `.depot/workflows/*.yml` | Auto-generated mirror of `.github/workflows/` |
| `.depot/migrate-config.yaml` | Advisory skip list — workflows we do **not** want mirrored |
| `scripts/depot-ci-sync.mjs` | Sync helper: runs `depot ci migrate` + applies skip list |
| `DEPOT_TOKEN` (GH repo secret) | Required for `depot/build-push-action@v1` and CLI access |

---

## Required secrets

Add these in **GitHub → Settings → Secrets and variables → Actions**:

- `DEPOT_TOKEN` — project-scoped token for `eliza-ai/eliza` → project `m89t0f0p08`.
  Mint at <https://depot.dev/orgs/.../settings/api-tokens> with scope **project: elizaAI**.

Rotate the token any time the Depot dashboard flags it as compromised or when
someone with access leaves. After rotating:

```bash
gh secret set DEPOT_TOKEN --repo eliza-ai/eliza --body "<new-token>"
```

---

## Disabling Depot (account unavailable / billing hold)

`build-docker.yml`, `build-cloud-agent.yml`, and `build-cloud-image.yml` all
gate their Depot steps on the **`DEPOT_ENABLED`** repo variable. Default
behavior is unchanged (Depot runs when the variable is unset or any value
other than `false`).

To force Docker builds onto the in-workflow Buildx fallback — useful when the
Depot account is on hold and you don't want every run to waste ~30s failing
the Depot step before falling back:

```bash
# Disable
gh variable set DEPOT_ENABLED --repo eliza-ai/eliza --body "false"

# Re-enable
gh variable delete DEPOT_ENABLED --repo eliza-ai/eliza
```

Or via the GitHub UI: **Settings → Secrets and variables → Actions → Variables → New repository variable**, name `DEPOT_ENABLED`, value `false`.

When disabled:
- `Set up Depot CLI` and `Build and push Docker image with Depot` are skipped.
- The Buildx fallback (`docker/build-push-action@v6` on the GHA-native daemon)
  runs unconditionally.
- All other Depot infrastructure (`.depot/`, `scripts/depot-ci-sync.mjs`,
  CI mirror workflows) stays in place — flip the variable back to re-enable.

---

## Regenerating the Depot mirror safely

**Never run `depot ci migrate workflows --overwrite` by hand.** The wrapper below
regenerates the mirror and re-applies the skip list from `.depot/migrate-config.yaml`:

```bash
# Preview what would change:
node scripts/depot-ci-sync.mjs --dry-run

# Apply:
node scripts/depot-ci-sync.mjs
```

### Current strategy

Depot CI mirror is **opt-in**, not default. We only keep mirrors for
Linux-heavy compute workflows. Everything else stays on canonical GHA:

**Kept on Depot CI** (compute-heavy Linux-only):
- `benchmark-tests.yml`, `nightly.yml`

**Docker builds** use `depot/build-push-action@v1` directly in the canonical
GHA workflow — no CI mirror needed, no 2× execution:
- `build-docker.yml`, `build-cloud-agent.yml`, `build-cloud-image.yml`,
  `docker-ci-smoke.yml`

**Skipped from Depot CI** (remap failures, fast jobs, or release-auth):

| Category | Workflows | Reason |
|---|---|---|
| Thin/fast | `ci.yml`, `auto-label.yml`, `agent-review.yml`, `agent-fix-ci.yml`, `integration-dod-gap-issues.yml`, `task-agent-cross-platform-review.yml` | <3min jobs; no Depot compute win |
| Cross-platform / macOS / Windows / mobile | `agent-release.yml`, `android-release.yml`, `apple-store-release.yml`, `mobile-build-smoke.yml`, `release-electrobun.yml`, `test-electrobun-release.yml`, `test-packaging.yml`, `test-flatpak.yml`, `update-homebrew.yml`, `windows-*.yml` | Depot CI remaps **every** non-`depot-*` label (`macos-14`, `windows-latest`, etc.) to `depot-ubuntu-latest`, which lacks Xcode / Android SDK / Windows SDK |
| Tests matrix | `test.yml` | `cloud-live-e2e` step ordering doesn't survive Depot mirror's checkout reordering |
| Release credentials | `publish-npm.yml`, `publish-packages.yml`, `reusable-npm-publish.yml`, `release-orchestrator.yml`, `snap-build-test.yml`, `deploy-origin-smoke.yml`, `deploy-web.yml`, `ci-fork.yml` | Keep on canonical GHA for OIDC/secret predictability |

> **Depot runner-label gotcha**: the [Depot compatibility doc](https://depot.dev/docs/github-actions/quickstart#migration-compatibility)
> states all non-Depot labels become `depot-ubuntu-latest`. macOS labels do
> **not** pass through to GitHub-hosted runners — any macOS/Windows workflow
> MUST be in the skip list or it will run on Linux and fail.

If you want to add or remove an entry, edit `skip:` in
`.depot/migrate-config.yaml` and re-run the sync script.

---

## Pinning runner labels in source

The Depot mirror generator rewrites `ubuntu-latest` → `depot-ubuntu-latest` and
(in older generator versions) `macos-latest` → `depot-ubuntu-latest`, which
breaks Xcode-dependent jobs. **Always pin labels in the source workflow** so
the mirror copies them verbatim:

- **Ubuntu**: `runs-on: ubuntu-24.04` (not `ubuntu-latest`)
- **macOS**: `runs-on: macos-14` or `macos-15` (not `macos-latest`) — these
  pass through Depot unchanged to GitHub-hosted runners
- **Depot runners** (when you explicitly want one): `runs-on: depot-ubuntu-24.04`

The current macOS pinning lives in:

- `.github/workflows/test.yml` — `website-blocker-mobile-ios`, `website-blocker-desktop-smoke`
- `.github/workflows/mobile-build-smoke.yml` — `build-ios`

---

## Docker build troubleshooting

**Symptom: `depot: command not found` in GHA**
- Missing `- uses: depot/setup-action@v1` step before the build step.

**Symptom: `Error: DEPOT_TOKEN is required`**
- Repo secret not set. See **Required secrets** above.

**Symptom: Depot build succeeds but GHCR push returns 403 Forbidden**
- The job is running on a branch where `GITHUB_TOKEN` lacks `packages: write`.
  Check `permissions:` at the workflow level — `build-docker.yml` sets both
  `packages: write` and `id-token: write`.

**Symptom: Build is slow on first run after a big Dockerfile change**
- Expected: layer cache misses. Subsequent builds will be fast again.
- If layer cache appears permanently broken:
  ```bash
  depot cache reset --project m89t0f0p08
  ```

---

## Local Docker builds against the Depot cache

Developers can optionally run Docker builds through Depot locally to share the
CI layer cache (instant pulls of cached layers):

```bash
depot configure-docker
export DEPOT_PROJECT_ID=m89t0f0p08
# Now `docker build` is routed through Depot:
docker build -f eliza/packages/app-core/deploy/Dockerfile.ci .
```

Undo with `depot configure-docker --uninstall`.

---

## Out-of-scope / future work

- Migrating Electrobun matrix to Depot CI — macOS-only workflows pass through
  to GitHub-hosted runners anyway, so Depot adds no value here.
- Full `depot ci` beta migration for remaining mirrored workflows
  (`release-electrobun`, `scenario-matrix`, etc.). Evaluate after the Docker
  migration has been stable for a few weeks.
