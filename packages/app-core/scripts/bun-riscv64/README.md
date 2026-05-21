# Bun riscv64-linux-musl cross-build pipeline

Produces the `bun-linux-riscv64-musl.zip` artifact consumed by the
Android agent staging step (`stage-android-agent.mjs`) when
`ELIZA_BUN_RISCV64_URL` points at a hosted copy.

Upstream Bun ships no riscv64 release
([oven-sh/bun#21923](https://github.com/oven-sh/bun/issues/21923) closed
without a roadmap). This pipeline builds one from source by cross-compiling
on an x86_64 Linux host with Docker.

## Layout

```
bun-riscv64/
  Dockerfile              cross-compile image (debian:bookworm + LLVM 21 + Rust nightly + Zig 0.14 + Alpine v3.21 riscv64 sysroot at /sysroot)
  build.sh                in-container build driver
  run-build.sh            host-side wrapper: docker build && docker run with the right mounts
  bun-version.json        single source of truth: Bun tag, WebKit commit, toolchain pins, JIT mode
  bun-patches/            patches against oven-sh/bun (Arch type + flags + CMake)
    README.md             which files to patch + why
  webkit-patches/         patches against oven-sh/WebKit @ pinned commit (JSC riscv64 LLInt + Baseline JIT)
    README.md             how to cherry-pick from upstream WebKit + WEBKIT_VERSION rationale
  dist/                   build artifacts; .gitignore'd except for build-log.txt
    bun-linux-riscv64-musl.zip
    bun-linux-riscv64-musl.zip.sha256
    build-log.txt         transcript of the most recent successful build
```

## Prerequisites (build host)

- Linux x86_64 with at least 8 cores and 16 GB RAM (32 GB recommended).
- Docker 25+ with buildx and the `tonistiigi/binfmt` QEMU emulators
  registered system-wide. Verify:

  ```bash
  docker run --rm --privileged tonistiigi/binfmt --install riscv64
  docker run --rm --platform linux/riscv64 alpine:3.21 uname -m
  # → riscv64
  ```

- ~60 GB of free disk space on the Docker storage volume (Bun + WebKit
  source + build caches).

## Building

Easiest path — the bundled host-side runner:

```bash
cd packages/app-core/scripts/bun-riscv64
./run-build.sh                # builds the image + runs the cross-compile
./run-build.sh --shell        # drop into the toolchain image for poking
./run-build.sh --image-only   # just build the image
./run-build.sh --no-cache     # rebuild the image from scratch
./run-build.sh --baseline-jit # experimental: requires realized WebKit patches
./run-build.sh --jobs 4       # cap parallel build jobs
```

Or invoke Docker directly:

```bash
cd packages/app-core/scripts/bun-riscv64

# 1. Build the image (caches the toolchain layer; only re-runs when
#    Dockerfile or its ARG values change).
docker build -t eliza/bun-riscv64-builder .

# 2. Run the cross-build. Mount the patches and version pin read-only,
#    and the dist directory writable for the artifact + log.
mkdir -p dist
docker run --rm \
    -v "$PWD/build.sh:/opt/build.sh:ro" \
    -v "$PWD/bun-version.json:/opt/bun-version.json:ro" \
    -v "$PWD/bun-patches:/opt/bun-patches:ro" \
    -v "$PWD/webkit-patches:/opt/webkit-patches:ro" \
    -v "$PWD/dist:/artifact" \
    -e JOBS=8 \
    eliza/bun-riscv64-builder
```

The build takes 30-90 minutes depending on host CPU. On success:

```
dist/bun-linux-riscv64-musl.zip
dist/bun-linux-riscv64-musl.zip.sha256
dist/build-log.txt
```

## C_LOOP artifact contract

The publishable riscv64 artifact is C_LOOP-only until the WebKit recipe
chain is checked in as patch files and validated. The bundled runner uses
the portable C interpreter by default:

```bash
docker run --rm \
    -v "$PWD/build.sh:/opt/build.sh:ro" \
    -v "$PWD/bun-version.json:/opt/bun-version.json:ro" \
    -v "$PWD/bun-patches:/opt/bun-patches:ro" \
    -v "$PWD/webkit-patches:/opt/webkit-patches:ro" \
    -v "$PWD/dist:/artifact" \
    -e BUN_RISCV64_FORCE_CLOOP=1 \
    eliza/bun-riscv64-builder
```

The resulting binary is slower (no JIT at all) but is the reproducible
contract both Android and Debian consume. `build-log.txt` records that
C_LOOP was used.

## Hosting the artifact + wiring into Android staging

`packages/app-core/scripts/lib/stage-android-agent.mjs` reads
`ELIZA_BUN_RISCV64_URL` and downloads the zip from there during the
Android APK assemble step. Acceptable hosting:

- a GitHub Release on an internal mirror of this repo,
- a static-asset bucket reachable from CI (`s3://...`, `gs://...`,
  `https://<bucket>.<cdn>/path/`),
- a workspace HTTP server for local dev (`python3 -m http.server 8000`
  from `dist/`).

After uploading `bun-linux-riscv64-musl.zip` plus a public URL with HTTPS:

```bash
export ELIZA_BUN_RISCV64_URL='https://example.com/.../bun-linux-riscv64-musl.zip'
bun run mobile:build  # or the equivalent android assemble path
```

`stage-android-agent.mjs` requires `ELIZA_BUN_RISCV64_SHA256` (or
`ELIZA_BUN_RISCV64_SHA256`), verifies the downloaded zip digest, extracts,
and stages `bun` into the APK's `assets/agent/riscv64/` directory alongside
the matching musl loader and libstdc++ pulled from Alpine v3.21.

## What's pinned and why

Read `bun-version.json` for the authoritative pins. Summary:

| Pin                | Value                                          | Why bumpable in lockstep |
|--------------------|------------------------------------------------|--------------------------|
| Bun tag            | `bun-v1.3.13`                                  | matches `stage-android-agent.mjs:BUN_VERSION` |
| WebKit fork commit | `4d5e75ebd84a14edbc7ae264245dcd77fe597c10`     | matches `scripts/build/deps/webkit.ts:WEBKIT_VERSION` on oven-sh/bun@bun-v1.3.13 |
| LLVM               | `21.1.8`                                       | matches Bun's pinned LLVM_VERSION; runtime allocator depends on no skew |
| Rust nightly       | `nightly-2025-12-10`                           | matches Bun's `rust-toolchain.toml` on `bun-v1.3.13` |
| Zig                | `0.14.1`                                       | first stable with `riscv64-linux-musl` target acceptance |
| Alpine branch      | `v3.21`                                        | matches `stage-android-agent.mjs:ALPINE_BRANCH` so musl/libstdc++ ABIs line up |

Any drift between these and the Android staging pipeline breaks the
runtime — for example, mismatched LLVM versions cause memory allocation
failures inside Bun. Bump them together.

## JIT tiers on riscv64

| Tier         | State                       | Source |
|--------------|-----------------------------|--------|
| LLInt        | Upstream                    | WebKit #229035 (closed r281757 2021-08-30) |
| Baseline JIT | Optional, recipe-only locally | WebKit #239708 (closed r293316 2022-04-24) |
| DFG JIT      | **Not implemented** (NEW)   | WebKit #238006 |
| FTL JIT      | **Not implemented** (NEW)   | WebKit #239707 |

`build.sh` defaults to C_LOOP for the publishable artifact. A Baseline
experiment must pass `BUN_RISCV64_FORCE_CLOOP=0` and must first convert
the recipe files under `webkit-patches/` into checked patch files.

## Limitations

- **No `bun:ffi` JIT-compile**. The `oven-sh/tinycc` fork has no
  riscv64-gen.c; `BUN_DISABLE_TINYCC=1` is set. Static FFI bindings still
  work — only the runtime C-source-to-shared-library path is gone.
- **No DFG/FTL JIT**, as documented above. Hot-loop JS will run on the
  Baseline tier only.
- **No prebuilt WebKit tarball**. The WebKit-side build is part of every
  `build.sh` invocation; expect 20-40 minutes for the WebKit half on
  reasonable hardware. Caching the WebKit checkout + build dir via a
  volume reduces this dramatically for iterative work — bind-mount
  `/work/src` as a named volume.

## Patch series status

| Side          | File                                              | State    |
|---------------|---------------------------------------------------|----------|
| Bun           | `0001-config-add-riscv64-arch.patch`              | written  |
| Bun           | `0002-flags-add-riscv64-march-mabi.patch`         | written  |
| Bun           | `0003-zig-add-riscv64-target-triple-and-cpu.patch`| written  |
| Bun           | `0004-webkit-force-local-mode-on-riscv64.patch`   | written  |
| Bun           | `0005-tinycc-disable-on-riscv64.patch`            | written  |
| Bun           | `0006-build-add-riscv64-cli-validation.patch`     | written  |
| Bun           | `0007-deps-per-dep-riscv64-checks.patch`          | written  |
| WebKit        | `0001-cherry-pick-llint-riscv64.recipe`           | recipe   |
| WebKit        | `0002-cherry-pick-baseline-jit-riscv64.recipe`    | recipe   |
| WebKit        | `0003-disable-dfg-ftl-on-riscv64.patch`           | written  |

**Written** = `*.patch` file that `git am --3way` applies on top of the
pinned upstream commit. **Recipe** = `*.recipe` file describing the
cherry-pick chain an operator must produce on a host with two WebKit
clones; `build.sh` refuses to proceed with Baseline JIT while recipes
exist (run with `BUN_RISCV64_FORCE_CLOOP=1` to build with C_LOOP instead).

## Validating the patch series

```bash
cd packages/app-core/scripts/bun-riscv64
./validate.sh
```

`validate.sh`:

1. Checks every `*.patch` + `*.recipe` matches its `bun-version.json:patch_series.*` SHA256.
2. Shallow-clones `oven-sh/bun @ bun.tag` to `/tmp/bun-riscv64-validate-bun` and runs `git apply --check` per Bun patch.
3. Shallow-clones `oven-sh/WebKit @ webkit.fork_commit` to `/tmp/bun-riscv64-validate-webkit` and runs `git apply --check` per WebKit patch.

Writes `dist/validate-report.txt`. Needs ~1.5 GB free in /tmp and network
access to github.com. Exits non-zero on hard failures (missing/corrupted
patch, clone failure); reports WARN (not FAIL) on context-drift apply
failures because `git am --3way` during the real build merges those
tolerantly.

## Realizing the WebKit recipes

Recipe files in `webkit-patches/` (`*.recipe`) document the cherry-pick
chain. To convert them to actual `*.patch` files, follow the recipe
header instructions:

```bash
# 1. Working WebKit clone + upstream remote
git clone https://github.com/oven-sh/WebKit.git /work/WebKit
cd /work/WebKit
git remote add upstream https://github.com/WebKit/WebKit.git
git fetch --filter=blob:none upstream main

# 2. Cherry-pick onto the pinned commit
git checkout -b riscv64-rebase 4d5e75ebd84a14edbc7ae264245dcd77fe597c10
git cherry-pick d9b48eb6 2c412363 7cab5669 30fad9e8 66db9c06 \
                849df0d9 b4c1b133 3d6fa6f5 37bf7544 7b1df19a \
                d11ef53d eabcb75e d2f4296a a276bc15 3aefcc51 \
                1c0ff93e 2abfe1cc
# (resolve conflicts per recipe notes)

# 3. Export as patches
git format-patch -o "$REPO_ROOT/packages/app-core/scripts/bun-riscv64/webkit-patches/" \
    --start-number=1 \
    4d5e75ebd84a14edbc7ae264245dcd77fe597c10..HEAD

# 4. Remove the recipes
rm "$REPO_ROOT/packages/app-core/scripts/bun-riscv64/webkit-patches/"*.recipe

# 5. Re-run validate.sh and update bun-version.json:patch_series sha256s
./validate.sh
```

## Punted items (follow-up tasks)

- **WebKit recipes not yet realized.** Two recipes (0001-llint, 0002-baseline)
  document the cherry-pick chain. An operator with a real WebKit clone +
  CI runner needs to produce ~15 actual `*.patch` files from the listed
  SHAs. Until that's done, the Baseline JIT path is gated; only `--c-loop`
  builds will run.
- **No first artifact yet.** Once the WebKit recipes are realized, run
  the build and commit `dist/build-log.txt`.
- **CI integration.** Hooking this build into the repo's CI (or a
  scheduled GitHub Action against a self-hosted x86_64 runner with
  Docker) so artifact builds are reproducible per Bun bump.
- **Artifact hosting policy.** Decide where the canonical riscv64 zip
  lives so `ELIZA_BUN_RISCV64_URL` has a stable production target.
