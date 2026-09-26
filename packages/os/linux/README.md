# elizaOS Linux

The persistent Debian 13 GNOME workstation uses
[mkosi](elizaos/mkosi/README.md). Build a development disk image from the repository
root with Docker running:

```bash
make -C packages/os/linux/elizaos build ARCH=amd64 PROFILE=gui
bun run --cwd packages/os verify:linux
```

The verification command requires Python's `cryptography` package (Debian:
`python3-cryptography`). Without host `mkosi`, its configuration lint performs
static checks only; image builds use the pinned builder container.

Supported architecture selectors are `amd64`, `arm64`, and `riscv64`. Cross builds
require the corresponding QEMU binfmt handler. Output is under
`elizaos/out/mkosi`. Development images may omit the Eliza application; release
images require verified desktop artifacts and the control broker.

`build.sh`, `make build`, and `just build` select the persistent mkosi image.
The older live-build ISO is available explicitly through `make legacy-iso`. The
[installer package](installer/README.md) currently provides planning and execution
contracts; its tests alone do not prove a deployable installer service.
