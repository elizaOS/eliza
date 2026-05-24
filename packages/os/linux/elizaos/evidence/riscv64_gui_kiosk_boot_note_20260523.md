# riscv64 GUI/kiosk boot path note - 2026-05-23

Scope: verify the riscv64 GUI/kiosk boot path separately from the headless
agent readiness smoke. This note is QEMU/transcript evidence only; it is not a
physical riscv64 board claim.

## GUI boot chain

The GUI port is present and wired as a locked kiosk session:

```text
graphical.target
  -> seatd.service
  -> elizaos-kiosk.service
  -> /usr/bin/cage -s -- /usr/local/lib/elizaos/start-kiosk
  -> epiphany-browser --application-mode http://127.0.0.1:31337/
```

Relevant files inspected:

- `config/package-lists/elizaos-common.list.chroot` installs `cage`, `seatd`,
  WebKitGTK/GTK runtime libraries, Mesa software-rendering support, and fonts.
- `config/package-lists/elizaos-riscv64.list.chroot` installs riscv64 kernel
  and UEFI bootloader packages, GNOME/GDM packages for desktop parity,
  `epiphany-browser`, Postgres, and Node fallback packages.
- `config/hooks/normal/0025-enable-graphical-session.hook.chroot` sets the
  default target to `graphical.target`, masks `gdm3`/`display-manager.service`,
  enables `seatd.service`, and enables `elizaos-kiosk.service`.
- `config/includes.chroot/etc/systemd/system/elizaos-kiosk.service` runs cage
  as the `user` account with `LIBSEAT_BACKEND=seatd`, `WLR_RENDERER=pixman`,
  and `ELIZAOS_AGENT_URL=http://127.0.0.1:31337`.
- `config/includes.chroot/usr/local/lib/elizaos/start-kiosk` launches the
  Electrobun app when present; on riscv64 it falls back to Epiphany/WebKitGTK
  in application mode after waiting for `/api/health`.
- `scripts/boot-qemu.sh` is the interactive GUI boot path.

GNOME/GDM packages are installed, but GDM is intentionally masked. The kiosk is
the boot GUI; it is not a fallback desktop session.

## Interactive riscv64 GUI command

Use:

```bash
make -C packages/os/linux/elizaos qemu-boot ARCH=riscv64
```

Equivalent direct command:

```bash
bash packages/os/linux/elizaos/scripts/boot-qemu.sh riscv64
```

For riscv64, `boot-qemu.sh` uses:

```text
qemu-system-riscv64
  -machine virt -cpu max
  -m 8192 -smp 4
  -drive if=pflash,format=raw,unit=0,readonly=on,file=/usr/share/qemu-efi-riscv64/RISCV_VIRT_CODE.fd
  -drive if=pflash,format=raw,unit=1,file=<runtime copy of RISCV_VIRT_VARS.fd>
  -drive file=<latest riscv64 ISO>,if=virtio,format=raw,media=cdrom,readonly=on
  -netdev user,id=n0 -device virtio-net-pci,netdev=n0
  -device virtio-gpu-pci
  -device qemu-xhci -device usb-tablet -device usb-kbd
  -display gtk
```

The important GUI-specific pieces are `-device virtio-gpu-pci` and
`-display gtk`. Plain headless `-nographic` QEMU does not provide a DRM/KMS GPU,
so wlroots/cage cannot create a backend there.

## Bounded GUI launch check

Host environment at check time:

```text
DISPLAY=:0
WAYLAND_DISPLAY=wayland-0
QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.16)
```

Bounded command run:

```bash
timeout --foreground 90s bash packages/os/linux/elizaos/scripts/boot-qemu.sh riscv64
```

ISO selected by the script:

```text
packages/os/linux/elizaos/out/elizaos-linux-riscv64-default-20260523T222632Z.iso
sha256: deb12416c3109752974b037d6cf0bb945ed809d68d8649991cdcd261bcbf7a4c
```

Result:

```text
Booting .../elizaos-linux-riscv64-default-20260523T222632Z.iso under QEMU (riscv64)...
qemu: terminating on signal 15 from pid ... (timeout)
exit code: 124
```

No immediate GTK/display setup failure occurred. The VM was terminated by
`timeout`, and a follow-up `pgrep -af 'qemu-system-riscv64|boot-qemu.sh'`
showed no remaining riscv64 QEMU process.

## Headless smoke is a separate proof path

The current headless smoke report is
`evidence/qemu_virt_boot.report.json`. It uses `-nographic` and failed on agent
readiness markers, not on GUI wiring:

```text
status: fail
iso: packages/os/linux/elizaos/out/elizaos-linux-riscv64-default-20260523T173927Z.iso
missing markers:
  - elizaos-curl-health-ready
  - elizaos-agent-ready
  - elizaos-tui-ready
forbidden markers present: []
```

The transcript still shows the graphical boot target and kiosk services being
started:

```text
Queued start job for default target graphical.target
Started seatd.service - Seat management daemon.
Started elizaos-kiosk.service - elizaOS locked single-app kiosk (cage + elizaOS app).
```

In `-nographic` mode, a cage/wlroots error such as "Found 0 GPUs" or "cannot
create backend" should be interpreted as expected for that proof path: there is
no virtual DRM/KMS device. Use `qemu-boot ARCH=riscv64` for GUI verification.

## Remaining GUI-specific blocker

No concrete GUI service-wiring bug was found. The remaining blocker observed in
the available evidence is agent readiness under the headless smoke path. The
riscv64 kiosk fallback waits for `http://127.0.0.1:31337/api/health` before
launching Epiphany, so a slow or unhealthy agent can delay the visible web UI
even when the GUI boot chain itself is present.
