# elizaOS Live OS — CI/CD production roadmap

Status snapshot: **8+ days of nightly red, no signed ISO ever published from CI.**
The scaffolding for production-grade signed releases is already wired
(SLSA Sigstore via OIDC, SHA256SUMS, SBOM via anchore/syft, GPG-signed APT
repo) — but the builds don't complete, so end users have no verifiable ISO.

This doc inventories what exists, what's broken, and a priority-ordered
plan to ship signed reproducible multi-arch releases that downstream users
can verify with `gh attestation verify <iso> --owner elizaOS`.

## Where we are (audit, 2026-05-25)

### Workflows that exist

| Workflow | Purpose | Status |
|---|---|---|
| `build-linux-iso.yml` | Build amd64/arm64/riscv64 ISO + SHA256SUMS + SBOM + SLSA attestation | 🔴 Failing every night for 8+ days. Same root cause across all 3 archs. |
| `elizaos-os-full-release.yml` | Tag-triggered release manifest validation + cross-artifact SHA256SUMS + SLSA over SHA256SUMS | 🔴 `startup_failure` (0–3 sec) on every release tag (v2.0.0, v2.0.1, v2.0.3) |
| `elizaos-os-release.yml` | Earlier release pipeline | 🟡 Status not audited |
| `update-os-release-manifest.yml` | Manifest update workflow | 🟡 Status not audited |
| `publish-apt-repo.yml` | GPG-signed Debian APT repo (`DEBIAN_GPG_PRIVATE_KEY` secret) | 🟡 Likely works when secret is configured; not run recently |
| `supply-chain.yaml` | SBOM (SPDX 2.3) + Grype vulnerability scan, weekly Mon 06:00 UTC | ✅ Works |
| `build-llama-ffi-linux.yml` | Compile llama.cpp FFI for Linux | 🟡 Not audited here |
| `release-electrobun.yml` | Electrobun signed release | 🟡 Not audited here |
| `flatpak-publish.yml` | Flatpak publishing | 🟡 Not audited here |
| `android-release.yml` / `publish-aosp-update-manifest.yml` | AOSP/Android release | Separate from Linux ISO scope |

### Releases published (npm only, ZERO ISO assets)

- v2.0.3 (2026-05-20) — latest stable
- v2.0.1 (2026-05-19)
- v2.0.0 (2026-05-19)
- v2.0.0-beta.2 (2026-05-17) — pre-release
- v2.0.0-alpha.535 (2026-05-02) — pre-release

None of these have a Linux ISO asset attached. Anyone who wants an
elizaOS Live USB currently must build it locally — there is no signed
download path.

## Root cause of the nightly red

CI step `just build` in `packages/os/linux/` runs the `elizaos-app` recipe
which checks `${app_out}/bin/launcher` exists OR `ELIZAOS_BUILD_APP=1` is
set. CI sets neither. With `ELIZAOS_BUILD_APP=1`, the recipe would build
the Electrobun app artifact from source (~20-30 min) before `lb build`
runs. Without it, the chroot hook (`9100-install-elizaos` or its
predecessor `0010-elizaos-agent.hook.chroot`) fails with:

```
ERROR: /opt/elizaos-artifacts missing; objective images require real elizaOS agent artifacts.
E: config/hooks/normal/0010-elizaos-agent.hook.chroot failed (exit non-zero).
```

This fails identically across all 3 matrix archs (amd64, arm64, riscv64).

### Two fix options

**Option A — single-job build** (simpler, slower per matrix entry)
Set `ELIZAOS_BUILD_APP: 1` in the build-iso step's env block. Build time per
arch grows from ~30 min to ~60 min, but no second job, no artifact
upload/download dance.

**Option B — split into prep-app + build-iso jobs** (faster overall, more moving parts)
1. `prep-app` job (runs once per matrix arch on a beefier runner): bun
   install + `bun run build:desktop` + upload-artifact the Electrobun
   `elizaOS-dev` tree (~2.5 GB).
2. `build-iso` job depends on prep-app: download-artifact, set
   `ELIZAOS_APP_ARTIFACT`, run `just build`.

Option A is the right first step. Option B is the optimization once A is
green.

## Industry standards (what real distros do)

| Practice | Reference | Where we are |
|---|---|---|
| Reproducible build (`SOURCE_DATE_EPOCH`) | Debian/Tails default | ✅ Set, verified in xorriso log |
| GPG-signed Release / Repomd | Debian, Fedora, Arch, Ubuntu | ✅ `publish-apt-repo.yml` scaffold; ⚠️ never end-to-end verified |
| SHA256SUMS file published alongside release | Universal | ✅ Scaffold in `build-linux-iso.yml`; ⚠️ never published (build fails) |
| Detached signature (`SHA256SUMS.asc` / `SHA256SUMS.sig`) | Debian, Fedora | ❌ Not wired |
| SLSA build provenance + `gh attestation verify` | Modern (k8s, Node.js, npm) | ✅ Scaffold via `actions/attest-build-provenance@v4`; ⚠️ never minted |
| SBOM (SPDX 2.3 or CycloneDX) attached to release | NIST/EO 14028 compliance | ✅ Working via `supply-chain.yaml` + scaffolded in build-iso |
| Multi-arch matrix | Debian (12+ arches), Fedora, Arch | 🟡 Matrix exists (amd64, arm64, riscv64) but all 3 fail |
| Signed end-user flasher tool | Tails (Tails Cloner), Fedora Media Writer, Rufus (signed Windows binary) | ❌ No flasher exists |
| `gh attestation verify` documented in release notes | Modern Sigstore practice | ❌ Not documented |
| Long-term download mirrors / torrent fallback | Debian, Fedora, Tails | ❌ N/A — no ISO ever published |

## Plan of attack (priority order)

### Phase 1 — Unstick the nightly (highest leverage)

1. **Fix `build-linux-iso.yml`**: add `ELIZAOS_BUILD_APP: 1` to the
   build-iso step's env. Bump `timeout-minutes` from 110 → 180 to absorb
   the ~30 min extra for the app build.
2. **Confirm nightly turns green** for at least amd64. Re-run via
   `workflow_dispatch` instead of waiting 24 hours.
3. **If arm64/riscv64 still fail after the env fix**, gate those matrix
   entries with `continue-on-error: true` until Phase 3 of the OS work
   lands real per-arch builds (see `packages/app-core/scripts/bun-riscv64/`
   for the riscv64 bun cross-build pipeline).

### Phase 2 — Fix the release tag path

4. **Diagnose `elizaos-os-full-release.yml` startup_failure**. Likely
   missing GitHub Environment configuration, missing required secrets,
   or invalid `permissions:` block. The 0–3 sec failure suggests a
   workflow-level rejection before any job runs.
5. **End-to-end test on a `workflow_dispatch`** before the next release
   tag — don't let a real release tag be the first time the chain runs.
6. **Verify the artifact handoff** between `build-linux-iso` (which
   uploads `elizaos-live-stable-*.iso` + `.sha256`) and
   `elizaos-os-full-release` (which expects them in `_artifacts/`).

### Phase 3 — Verify end-user verification path

7. Trigger `build-linux-iso.yml` via `workflow_dispatch` against develop.
8. Download the resulting ISO + SHA256SUMS + SBOM from the artifact tab.
9. Run `gh attestation verify <iso> --owner elizaOS`. This must succeed
   — if it doesn't, the SLSA attestation isn't being minted correctly
   even when the build completes.
10. Add the verify command + sha256sum command to the release notes
    template (`.github/release-template.md` or equivalent).

### Phase 4 — Extend matrix to true multi-arch

11. **arm64** — already in the matrix. Once Phase 1 lands, this should
    work since Bun + Electrobun both have official arm64 Linux releases
    (`bun-linux-aarch64.zip`, `electrobun-{cef,cli,core}-linux-arm64.tar.gz`).
    The Dockerfile + build.sh need parameterization to swap
    `grub-efi-amd64-bin`/`linux-image-amd64` for the arm64 equivalents.
12. **riscv64** — gated on (a) Shaw pushing electrobun-riscv64
    enablement patches (current `upstreams/electrobun-patches/` only has
    diagnostic instrumentation) AND (b) running Shaw's
    `packages/app-core/scripts/bun-riscv64/run-build.sh` to produce the
    `bun-linux-riscv64-musl.zip` (~8h cross-compile). Workflow can
    consume the resulting zip via `ELIZA_BUN_RISCV64_URL`.

### Phase 5 — Signed end-user USB flasher

13. **Choose tech**: Rust + Tauri (cross-platform, signed bundles per
    OS) OR a signed bash script + GUI overlay (Zenity/Yad).
14. **Required behavior** (per `packages/os/CLAUDE.md`):
    - Show only eligible removable drives
    - Verify image checksum + signature before writing
    - Require destructive confirmation with the exact target device
    - Refuse internal/root disks
    - Write, sync, verify, save a non-secret local install log
15. **Sign per platform**: notarized macOS package, signed Windows
    installer, Linux AppImage with detached signature.

### Phase 6 — Long-term release hygiene

16. **Torrent + IPFS fallback** for the ISO (Debian, Fedora, Tails all
    publish torrents for resilience).
17. **Mirror network** — publish via 2-3 mirrors with signed metadata.
18. **Update channels** — `alpha`/`beta`/`stable`/`enterprise` rings
    per `packages/os/CLAUDE.md`, with manifest publishing to a
    versioned URL.
19. **Hardware support matrix** as part of release notes — what real
    hardware has been tested per release.
20. **Reproducibility verification** by a third party — Debian's
    [reproducible-builds.org](https://reproducible-builds.org/) model.
    Two independent builders → identical SHA256.

## Concrete next sessions

- **Session A** (2h): Phase 1 — fix `ELIZAOS_BUILD_APP` env, push fix in
  separate PR, re-run via workflow_dispatch, watch turn green. THIS
  IS WHERE I'D START.
- **Session B** (2h): Phase 2 — diagnose + fix
  `elizaos-os-full-release.yml` startup_failure.
- **Session C** (1h): Phase 3 — verify `gh attestation verify` works.
- **Sessions D-E** (4-6h): Phase 4 arm64 — parameterize Dockerfile +
  build.sh, test locally, push fix to multi-arch.
- **Sessions F+** (open-ended): Phase 4 riscv64 (depends on Shaw),
  Phase 5 flasher tool.

## Why this matters

Every day without a signed ISO published from CI is a day where:
- Users have no verifiable way to get elizaOS Live USB
- Each `git pull && just build` is "trust me, bro" — no chain of custody
- Security researchers can't audit a single canonical artifact
- The substantial SLSA/Sigstore scaffolding that's already wired earns
  zero return on the investment
- Phase 3 (multi-arch) work can't be validated by CI nightly until the
  CI builds work at all

The fixes are not large. The first one is **a single env-var addition in
the build step**.

## Open questions / decisions needed

- **GPG signing keys** — who owns the elizaOS release signing key?
  Where is it stored (GitHub Environment secret? Sigstore alone?)? Has
  it been rotated recently?
- **Mirror infrastructure** — does elizaOS have / want CDN-backed
  mirrors for the ISO downloads, or rely on GitHub Releases (which has
  per-release 2 GB asset cap)?
- **Update channel cadence** — nightly vs weekly vs monthly for `beta`
  channel? `stable` only on tagged releases?
- **Hardware test matrix** — what's the minimum set of real-hardware
  models we'll claim support for? Apple Silicon? Framework? ThinkPad?
  Raspberry Pi 5 (arm64)? VisionFive 2 (riscv64)?

## Living-doc references

- HANDOFF (session memory): `~/.claude/projects/-home-nubs-Git-iqlabs/memory/HANDOFF_2026-05-25_phase2_done_phase3_plan.md`
- Stale-cache bug note: `~/.claude/projects/-home-nubs-Git-iqlabs/memory/milady_outer_node_modules_stale_cache_bug.md`
- Distribution channels overview: `packages/os/CLAUDE.md`
