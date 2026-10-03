# Experimental Bun Rust-core port

The [cross-build wrapper](../README.md) selects this patch series with `--rust-core`.
Its upstream commit and Rust toolchain are pinned in [bun-version.json](../bun-version.json).
WebKit uses the shared patch series with replacements from `webkit-patches/`
for this revision. The wrapper retains the shared JIT recipe checks.
