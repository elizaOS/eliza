# Portable Linux fused-inference builder

This builder prevents the Linux desktop inference libraries from inheriting a
newer development host's GNU libc or CPU instruction set. It reproduces the
proven Linux x64 build inside an **unprivileged** `mmdebstrap` Bookworm root:

- Debian snapshot `20250101T000000Z` (`glibc 2.36`);
- elizaOS llama.cpp fork commit
  `6543d9078051a9bb194c2ef5c2995f003c5158de`;
- official Khronos Vulkan-Headers tag `v1.4.357`, dereferenced and verified as
  commit `e3b1eec08173d6b825cd3ac88c885a63b621504a`;
- Bookworm's pinned `spirv-headers` CMake package, required by the Vulkan build;
- Vulkan plus CPU fallback, with host CPU tuning disabled (`--portable-cpu`);
- a fail-closed audit of every staged ELF against the desktop `GLIBC_2.38`
  ceiling.

Inspect the immutable plan or run only the local preflight without downloading
or compiling:

```bash
bun run linux:build-portable-fused-inference -- --print-plan
bun run linux:build-portable-fused-inference -- \
  --preflight-only --out /absolute/new-output-directory
```

Run the expensive build with at least 8 GiB and 150,000 inodes free under the
temporary workspace:

```bash
bun run linux:build-portable-fused-inference -- \
  --out /absolute/new-output-directory
```

The output path must not exist. The builder downloads only the two pinned Git
inputs and Debian's signed snapshot packages. It builds and audits in temporary
directories, copies into a sibling staging directory, then atomically renames
that directory into place. Interrupt and failure cleanup targets only its
uniquely named temporary directories; `--keep-temp` retains the chroot for
diagnosis.

`PORTABLE_FUSED_PROVENANCE.json` records the Debian package versions, input
commits, Vulkan header-tree SHA-256, CPU/backend policy, per-ELF GNU libc
requirements, and SHA-256/size/mode for every staged runtime file. The existing
`.eliza-fused-build-stamp.json` remains alongside it for runtime staleness
checks.

When staging this output into `dist/local-inference/lib` or another desktop
bundle, copy the **entire directory contents**, not only `*.so` files. Keep
`PORTABLE_FUSED_PROVENANCE.json` and `.eliza-fused-build-stamp.json` beside the
complete unversioned and `.so.0` library set. The provenance manifest is the
portable-build identity and checksum record; dropping it makes the package
indistinguishable from a host-native manual build even if its binaries happen
to satisfy the GNU libc ceiling.

This command produces the portable fused-library set only. It intentionally
does not package, modify, or invoke Electrobun artifacts.
