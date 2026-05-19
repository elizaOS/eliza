# Bun riscv64-linux-musl cross-build pipeline

Produces the `bun-linux-riscv64-musl.zip` artifact consumed by the
Android agent staging step (`stage-android-agent.mjs`) when
`MILADY_BUN_RISCV64_URL` points at a hosted copy.

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
./run-build.sh --c-loop       # fallback: build with ENABLE_C_LOOP=ON
./run-build.sh --jobs 4       # cap parallel build jobs
```

Or invoke Docker directly:

```bash
cd packages/app-core/scripts/bun-riscv64

# 1. Build the image (caches the toolchain layer; only re-runs when
#    Dockerfile or its ARG values change).
docker build -t milady/bun-riscv64-builder .

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
    milady/bun-riscv64-builder
```

The build takes 30-90 minutes depending on host CPU. On success:

```
dist/bun-linux-riscv64-musl.zip
dist/bun-linux-riscv64-musl.zip.sha256
dist/build-log.txt
```

## C_LOOP fallback

If the Baseline JIT bringup fails (typically inside `offlineasm` or LLInt
prologue), retry with the portable C interpreter:

```bash
docker run --rm \
    -v "$PWD/build.sh:/opt/build.sh:ro" \
    -v "$PWD/bun-version.json:/opt/bun-version.json:ro" \
    -v "$PWD/bun-patches:/opt/bun-patches:ro" \
    -v "$PWD/webkit-patches:/opt/webkit-patches:ro" \
    -v "$PWD/dist:/artifact" \
    -e BUN_RISCV64_FORCE_CLOOP=1 \
    milady/bun-riscv64-builder
```

The resulting binary is slower (no JIT at all) but guaranteed to build on
any LP64D RISC-V target. `build-log.txt` records that C_LOOP was used so
downstream consumers know a Baseline rebuild is desirable.

## Hosting the artifact + wiring into Android staging

`packages/app-core/scripts/lib/stage-android-agent.mjs` reads
`MILADY_BUN_RISCV64_URL` and downloads the zip from there during the
Android APK assemble step. Acceptable hosting:

- a GitHub Release on an internal mirror of this repo,
- a static-asset bucket reachable from CI (`s3://...`, `gs://...`,
  `https://<bucket>.<cdn>/path/`),
- a workspace HTTP server for local dev (`python3 -m http.server 8000`
  from `dist/`).

After uploading `bun-linux-riscv64-musl.zip` plus a public URL with HTTPS:

```bash
export MILADY_BUN_RISCV64_URL='https://example.com/.../bun-linux-riscv64-musl.zip'
bun run mobile:build  # or the equivalent android assemble path
```

`stage-android-agent.mjs` will fetch, verify (zip integrity), extract,
and stage `bun` into the APK's `assets/agent/riscv64/` directory alongside
the matching musl loader and libstdc++ pulled from Alpine v3.21.

## What's pinned and why

Read `bun-version.json` for the authoritative pins. Summary:

| Pin                | Value                                          | Why bumpable in lockstep |
|--------------------|------------------------------------------------|--------------------------|
| Bun tag            | `bun-v1.3.13`                                  | matches `stage-android-agent.mjs:BUN_VERSION` |
| WebKit fork commit | `3167a44fb92c268c83f09b232b38a9f3e7f9655a`     | matches `scripts/build/deps/webkit.ts:WEBKIT_VERSION` on oven-sh/bun@main |
| LLVM               | `21.1.8`                                       | matches Bun's pinned LLVM_VERSION; runtime allocator depends on no skew |
| Rust nightly       | `nightly-2026-05-06`                           | matches Bun's `rust-toolchain.toml` |
| Zig                | `0.14.1`                                       | first stable with `riscv64-linux-musl` target acceptance |
| Alpine branch      | `v3.21`                                        | matches `stage-android-agent.mjs:ALPINE_BRANCH` so musl/libstdc++ ABIs line up |

Any drift between these and the Android staging pipeline breaks the
runtime — for example, mismatched LLVM versions cause memory allocation
failures inside Bun. Bump them together.

## JIT tiers on riscv64

| Tier         | State                       | Source |
|--------------|-----------------------------|--------|
| LLInt        | Upstream                    | WebKit #229035 (closed r281757 2021-08-30) |
| Baseline JIT | Upstream                    | WebKit #239708 (closed r293316 2022-04-24) |
| DFG JIT      | **Not implemented** (NEW)   | WebKit #238006 |
| FTL JIT      | **Not implemented** (NEW)   | WebKit #239707 |

`build.sh` enables LLInt + Baseline and disables DFG + FTL. Acceptable
for the Android agent runtime, which is bottlenecked on native llama.cpp
inference and network I/O, not JS hot loops.

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

## Punted items (follow-up tasks)

- **Patches not yet written.** `bun-patches/` and `webkit-patches/` only
  contain `README.md`s describing what to patch and why. A follow-up
  task with a host that can hold the full Bun + WebKit checkouts and
  iterate against actual build output is required to produce the
  numbered `*.patch` files. The pipeline scaffolding is complete; the
  patch authoring is the gating step.
- **No first artifact yet.** Once the patch series exists, run the build
  and commit `dist/build-log.txt`.
- **CI integration.** Hooking this build into the repo's CI (or a
  scheduled GitHub Action against a self-hosted x86_64 runner with
  Docker) so artifact builds are reproducible per Bun bump.
- **Artifact hosting policy.** Decide where the canonical riscv64 zip
  lives so `MILADY_BUN_RISCV64_URL` has a stable production target.
