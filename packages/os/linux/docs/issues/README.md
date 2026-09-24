# Ready-to-file elizaOS Linux v1 issues

These issue bodies are the remaining execution gates after the macOS-safe
source work in `docs/mkosi-v1-architecture.md`. They are written so they can be
copied into GitHub without converting a planning note into a false completion
claim.

## Linux or hardware lab issues (`elizaOS/os`)

1. [`01-build-boot-mkosi-multiarch.md`](./01-build-boot-mkosi-multiarch.md) — [elizaOS/os#18](https://github.com/elizaOS/os/issues/18)
2. [`02-physical-usb-qualification.md`](./02-physical-usb-qualification.md) — [elizaOS/os#19](https://github.com/elizaOS/os/issues/19)
3. [`03-alongside-install-qualification.md`](./03-alongside-install-qualification.md) — [elizaOS/os#20](https://github.com/elizaOS/os/issues/20)
4. [`04-gnome-control-cloud-phone-e2e.md`](./04-gnome-control-cloud-phone-e2e.md) — [elizaOS/os#21](https://github.com/elizaOS/os/issues/21)
5. [`05-riscv64-board-qualification.md`](./05-riscv64-board-qualification.md) — [elizaOS/os#22](https://github.com/elizaOS/os/issues/22)
6. [`06-release-signing-and-promotion.md`](./06-release-signing-and-promotion.md) — [elizaOS/os#23](https://github.com/elizaOS/os/issues/23)
7. [`09-apple-silicon-alongside.md`](./09-apple-silicon-alongside.md) — [elizaOS/os#24](https://github.com/elizaOS/os/issues/24)
8. [`10-vanilla-debian-desktop-package.md`](./10-vanilla-debian-desktop-package.md) — [elizaOS/os#25](https://github.com/elizaOS/os/issues/25)

## Cross-repository issues (`elizaOS/eliza`)

1. [`07-linux-gtk-shell.md`](./07-linux-gtk-shell.md) — [elizaOS/eliza#21783](https://github.com/elizaOS/eliza/issues/21783)
2. [`08-phone-remote-production.md`](./08-phone-remote-production.md) — [elizaOS/eliza#21784](https://github.com/elizaOS/eliza/issues/21784)

The Apple Silicon issue spans both repositories conceptually, but its boot,
storage, recovery, and installer release boundary is filed in `elizaOS/os`.

An issue may be closed only with evidence tied to an immutable OS commit,
Eliza artifact commit, image digest, and exact test environment. A screenshot
or a successful build without retained logs is not release evidence.
