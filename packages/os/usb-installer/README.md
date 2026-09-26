# @elizaos/os-usb-installer

Electrobun application for preparing bootable elizaOS USB installers.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/os/usb-installer build  # build
bun run --cwd packages/os/usb-installer test   # tests
```

Linux app packaging builds the native raw writer with a C compiler and OpenSSL
development headers (`libssl-dev` on Debian). Build on the target Linux
architecture. For an unpackaged backend, first run
`bash native/build-raw-writer.sh "$PWD/native/build/linux-raw-writer"` from this
package. The writer requires kernel disk sequence support and retains an
exclusive whole-device descriptor through write, flush, and readback. It is
invoked through the desktop privilege prompt; never install it setuid.

For disposable QEMU tests, bundle `native/qualify-raw-pipeline.ts` with
`bun build --target=node --format=esm`. Run
`python3 native/qualify-raw-writer-vm.py --help` for the required bundle, Node,
and hash-pinned Debian base paths.
Extract the native writer from a final Linux installer with
`../scripts/verify-electrobun-linux-package.sh <installer.tar.gz> <new-writer-path>`
(requires `zstd`). Pass that path to `--packaged-helper` to qualify its exact bytes
instead of compiling a new helper inside the guest. Linux release CI requires both
sector-size runs before recording release evidence.
Use a fresh repository-root `test-results/` output directory for each 512/4096-byte
sector run. These tests cover raw writes and readback, not OS boot or installation.
