# WebKit riscv64 patches

This directory holds the WebKit-side patches that have to land on top of
`oven-sh/WebKit @ ${WEBKIT_COMMIT}` (see `../bun-version.json:webkit.fork_commit`)
to produce a buildable JavaScriptCore for `riscv64-unknown-linux-musl` with
LLInt + Baseline JIT enabled.

`build.sh` applies every `*.patch` in this directory **in lexical order**
via `git am --3way` inside the WebKit clone. Name files `NNNN-short-name.patch`
where `NNNN` is a zero-padded four-digit ordinal.

## Why these are needed

`oven-sh/WebKit` is Bun's WebKit fork. As of the pinned commit it has
**zero** riscv64 patches — Bun has never had a riscv64 target. The patches
needed fall into three buckets:

### Bucket 1: cherry-pick the upstream WebKit riscv64 enablement

The upstream WebKit/WebKit repo already has the riscv64 LLInt + Baseline
JIT landed:

- **WebKit bug #229035** ("Add support for the RISC-V 64 architecture using
  the C_LOOP backend") — closed by r281757, landed 2021-08-30. Source:
  https://bugs.webkit.org/show_bug.cgi?id=229035
- **WebKit bug #239708** ("Implement RISC-V 64 LLInt and baseline JIT") —
  closed by r293316, landed 2022-04-24. Source:
  https://bugs.webkit.org/show_bug.cgi?id=239708

Both bugs map to a small number of Subversion commits in
`Source/JavaScriptCore/{assembler,llint,jit,offlineasm}` plus
`Source/WTF/wtf/{Platform.h,PlatformCPU.h,PlatformEnable.h}`. Steps to
extract them as patches against the Bun fork:

```
# Inside a working clone of upstream WebKit/WebKit (mirror):
git log --all --oneline --grep='RISC-V 64' --grep='RISCV64' --regexp-ignore-case
# Identify the merge commits for r281757 + r293316 + their incremental
# follow-ups (there are usually 5-10 fixups). Cherry-pick each onto
# oven-sh/WebKit @ WEBKIT_COMMIT in a topic branch:
git checkout -b riscv64-rebase 3167a44fb92c268c83f09b232b38a9f3e7f9655a
git cherry-pick <sha-1> <sha-2> ...
# Resolve conflicts. Most will be in JavaScriptCore/assembler (the Bun
# fork has aggressive changes here — JSC::Disassembler refactors and
# similar). Then emit patches:
git format-patch -o ../webkit-patches/ \
    3167a44fb92c268c83f09b232b38a9f3e7f9655a..HEAD
```

### Bucket 2: build-system follow-ups

The 2022-era riscv64 patches predate WebKit's current CMake organization.
Even after cherry-picking, the build will likely need:

- **`Source/cmake/OptionsCommon.cmake`** / `WebKitCompilerFlags.cmake` —
  teach the per-CPU flag dispatcher that `WTF_CPU_RISCV64` maps to
  `-march=rv64gc -mabi=lp64d`. Without this, `cmake` emits no `-march`
  and clang complains about missing extension prefixes (F, D, A, C).
- **`Source/JavaScriptCore/CMakeLists.txt`** — include `RISCV64*.cpp`
  assembler / disassembler sources in `JavaScriptCore_SOURCES` when
  `WTF_CPU_RISCV64`.
- **`Source/JavaScriptCore/offlineasm/instructions.rb`** + `riscv64.rb`
  — the offlineasm DSL has a riscv64 backend in upstream WebKit but the
  Bun fork's `instructions.rb` has been refactored. Reconcile.

### Bucket 3: the WebKitGTK 2.46.x LLInt regression

WebKit bug #281138 ("LLInt regression on RISC-V 64 after WebKitGTK 2.46")
reports a runtime crash that was introduced between WebKitGTK 2.44 and
2.46. The Bun WEBKIT_VERSION pin is several months newer than 2.46.x, so
unless cherry-picks bring the regression along we should be fine. If
`bun --version` runs but `bun ./trivial.js` crashes inside LLInt prologue,
the suspected commit range is documented in #281138 comments — bisect
within the cherry-picked series.

## What's still NOT implemented in WebKit

- **DFG JIT** (WebKit bug #238006 — NEW, no patch series). Acceptable.
- **FTL JIT** (WebKit bug #239707 — NEW, no patch series). Acceptable.

Both DFG and FTL are explicitly disabled by `build.sh` regardless. Bun's
agent runtime is bottlenecked on llama.cpp + network IO, not JS hot loops,
so losing the upper tiers costs little.

## Fallback: C_LOOP

If the Baseline JIT bringup turns out to be more invasive than time
permits, set `BUN_RISCV64_FORCE_CLOOP=1` when running `build.sh`. That
skips this patch series' JIT-specific changes and builds JSC with
`ENABLE_C_LOOP=ON` instead — pure portable interpreter, slow but
guaranteed to work on any LP64D RISC-V target. The build log will record
that the artifact was built in C_LOOP mode so downstream consumers can
prioritize a Baseline rebuild.

## File-naming convention

```
0001-jsc-platformcpu-add-riscv64-marker.patch
0002-jsc-assembler-include-riscv64-sources.patch
0003-jsc-llint-cherrypick-r281757-c-loop.patch
0004-jsc-llint-cherrypick-r293316-baseline.patch
0005-jsc-offlineasm-add-riscv64-backend.patch
0006-cmake-riscv64-march-flags.patch
...
```

The bucket-1 (cherry-pick) patches keep their upstream commit prefixes
in the subject line for traceability; bucket-2 / bucket-3 patches author
themselves locally with `Co-Authored-By: Claude Opus 4.7 (1M context)
<noreply@anthropic.com>` per the repo convention.

## Why we can't pre-populate the patches in this commit

A correct cherry-pick series requires (a) a working WebKit clone with
both Bun's fork and the upstream WebKit/WebKit remote, (b) running
`git cherry-pick` interactively to resolve conflicts in the
Bun-modified files, and (c) iterating against actual build output to
fix any post-cherry-pick CMake / offlineasm issues. None of that is
feasible inside the constraints of the agent shell that wrote this
pipeline (no WebKit clone fits in the working set; the cherry-pick
conflicts need human judgement). The build pipeline is ready; the
patch series is the gating step a follow-up operator with a checkout
on a beefy host will produce.
