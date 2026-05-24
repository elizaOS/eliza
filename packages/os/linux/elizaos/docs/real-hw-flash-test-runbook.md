# elizaOS Live — real-hardware flash + boot + evidence runbook

You are about to flash a USB stick with the elizaOS Live ISO, boot it on a
real machine, and collect evidence that the locked Electrobun kiosk renders
correctly (chat pill + view manager fullscreen). This validates the path that
deadlocks under every QEMU GL backend we have tried.

The ISO targeted by this runbook:

```
packages/os/linux/elizaos/out/elizaos-linux-amd64-default-20260524T021428Z.iso
```

SHA256 (also in the `.sha256` sidecar):

```
457062a21ffe205e6a361eab52113d2fe1da19f1542d3aec607d41e33fde093f
```

If you build a newer ISO, replace the timestamp throughout this runbook.

---

## 1. Pre-flight

Run on your Linux host (not on the live USB):

```bash
ISO=packages/os/linux/elizaos/out/elizaos-linux-amd64-default-20260524T021428Z.iso
cd "$(dirname "$ISO")" && sha256sum -c "$(basename "$ISO").sha256" && cd -
file "$ISO"
```

Expect:

- `OK` from `sha256sum -c`
- `ISO 9660 CD-ROM filesystem data (DOS/MBR boot sector) 'Debian trixie ...' (bootable)`

The ISO is iso-hybrid: UEFI (via `EFI/boot/bootx64.efi`) and Legacy BIOS
(via the embedded `grub-pc` MBR record). It boots both ways unmodified.

---

## 2. Identify the target USB

Insert the USB stick. List eligible removable disks:

```bash
lsblk -dpo NAME,SIZE,RM,MODEL,SERIAL
```

The target must have `RM=1`. Note the device path (e.g. `/dev/sdb`). Do NOT
pick the disk holding your `/` (the flasher refuses anyway, but verify
yourself first).

USB stick capacity must be >= ISO size (~2.1 GB). A 16 GB+ stick is
recommended so you can also provision the optional evidence partition
(section 6 below).

---

## 3. Flash command

Use the guarded flasher (shows device info, verifies checksum, refuses root
disks, requires typed device-path confirmation, performs readback verify):

```bash
sudo packages/os/linux/elizaos/scripts/flash-usb.sh \
  --iso packages/os/linux/elizaos/out/elizaos-linux-amd64-default-20260524T021428Z.iso \
  --device /dev/sdX
```

Replace `/dev/sdX` with the path from section 2. Omit `--device` to be
prompted interactively.

You will see:

1. SHA256 verification of the ISO.
2. Target device details (model, serial, capacity, partitions, mounts).
3. Auto-unmount of any currently-mounted partitions on the target.
4. A confirmation prompt that requires you to type the exact device path.
5. `dd` write with `status=progress`.
6. Sync + head-of-device SHA256 readback compared to the ISO SHA256.
7. An install log written next to the ISO at `<iso>.flash-<utc>.log`.

If anything fails the script exits non-zero and prints the reason. No
silent fallbacks.

---

## 4. Boot the machine

1. Shut down the target machine. Insert the freshly flashed USB.
2. Enter the firmware boot menu (typical keys: F12, F10, Esc, F2 depending
   on vendor). Pick the USB stick.
3. The machine may boot the USB as **UEFI** or **Legacy BIOS** — both work.
   Prefer the UEFI entry (`UEFI: <USB model>`) when present; it matches the
   Secure-Boot-disabled grub-efi path we built. If only the BIOS entry boots,
   that is fine — the i386-pc GRUB stage is also in the ISO.

### Expected boot stages

| Stage | What you see | Notes |
|---|---|---|
| Firmware | Vendor logo, then boot picker | Pick the USB. |
| GRUB | elizaOS-branded GRUB menu, default entry highlighted | Auto-boots in a few seconds. |
| Kernel/initrd | Brief text scroll, then handover | `quiet splash` is set; expect mostly silent. |
| Plymouth | elizaOS boot splash | Animated splash while userland comes up. |
| Seat takeover | Brief black screen (1-3 s) | seatd grabs the VT for the kiosk. |
| Kiosk | Fullscreen Electrobun window | Chat pill at bottom, view manager visible. |

Total time from GRUB selection to kiosk should be roughly 20–60 s depending
on the machine.

---

## 5. What success looks like

- The kiosk is fullscreen with **no window decorations** (no title bar, no
  taskbar, no GNOME shell). There is no path out of the kiosk.
- The chat input pill is rendered at the bottom of the screen.
- The view manager (sidebar / content area) is rendered and interactive.
- `Ctrl+Alt+F2` does **not** switch you out (the kiosk owns tty1, and there
  is no login on other VTs by default).

Take a phone photo of the screen. That photo is the primary evidence.

---

## 6. Optional: enable on-USB evidence capture

If you want kiosk screenshots + journal + dmesg written back to the USB
automatically, provision a second partition on the USB **before** booting:

```bash
# After flashing (section 3), inspect the partition table:
sudo parted /dev/sdX print free

# Create a FAT32 partition in the remaining free space and label it
# ELIZAOS-EVIDENCE. Replace <START> and <END> with values from `parted`.
sudo parted /dev/sdX mkpart primary fat32 <START> <END>
sudo mkfs.vfat -n ELIZAOS-EVIDENCE /dev/sdX4   # part number may differ
```

At boot, `elizaos-real-hw-evidence.service` looks up the partition by the
`ELIZAOS-EVIDENCE` label. If present it mounts it RW and writes, into a
timestamped subdirectory:

| File | Contents |
|---|---|
| `env.txt` | uname, /proc/cmdline, DRM driver, /dev/dri, lspci GPU info |
| `dmesg.log` | kernel ring buffer |
| `journal.log` | full journal of the current boot (refreshed every 30 s) |
| `kiosk-00.png` … `kiosk-09.png` | scrot screenshots, 30 s apart, 5 min total |

If no `ELIZAOS-EVIDENCE` partition exists the service exits silently — no
effect on the boot.

After the capture window finishes (or after you have seen what you need),
shut down the machine and remove the USB.

---

## 7. Mounting the EVIDENCE partition after pulling the USB

### Linux

```bash
udisksctl mount -b /dev/disk/by-label/ELIZAOS-EVIDENCE
# evidence files appear at /run/media/$USER/ELIZAOS-EVIDENCE/<utc-stamp>/
```

### macOS

Plug the USB in. macOS auto-mounts FAT32. The volume appears as
`/Volumes/ELIZAOS-EVIDENCE`. Open Finder or:

```bash
ls /Volumes/ELIZAOS-EVIDENCE
```

---

## 8. Filing the evidence

Copy the timestamped subdirectory from the EVIDENCE partition into this
repo under `evidence/real-hw/`:

```bash
STAMP=<the utc timestamp dir on the USB>
mkdir -p evidence/real-hw/${STAMP}
cp -r /run/media/$USER/ELIZAOS-EVIDENCE/${STAMP}/* evidence/real-hw/${STAMP}/

# Also include the phone photo of the screen, plus the flash log.
cp <phone-photo>.jpg evidence/real-hw/${STAMP}/screen-photo.jpg
cp packages/os/linux/elizaos/out/<iso>.flash-*.log evidence/real-hw/${STAMP}/

git add evidence/real-hw/${STAMP}
git commit -m "evidence(real-hw): elizaOS kiosk boot on <machine> ${STAMP}

ISO: elizaos-linux-amd64-default-20260524T021428Z.iso
Machine: <vendor model, CPU, GPU>
Boot mode: <UEFI|BIOS>
Result: <kiosk rendered | black screen | panic | grub-stuck>
Notes: <anything notable>
"
git push
```

## 9. Triage table — when boot does not succeed

| Symptom | First file to look at on EVIDENCE | Likely cause |
|---|---|---|
| GRUB stuck / loops | n/a (no userland) | bootloader / firmware compat; try the other boot mode (UEFI vs BIOS) |
| Kernel panic before Plymouth | `dmesg.log` (won't exist; capture with phone) | kernel/driver mismatch on this hardware |
| Plymouth then black | `journal.log`, `env.txt` (DRM driver line) | DRM driver missing / GL init failed; check `start-xorg-kiosk` notes |
| Plymouth then text console | `journal.log` | kiosk service failed; grep for `elizaos-kiosk` |
| Kiosk window black | `kiosk-NN.png`, `journal.log` | WebKit/Electrobun render failure (same class as the QEMU deadlock) |
| Kiosk renders but no chat pill | `kiosk-NN.png` | agent/UI bug — capture and file |

## 10. What this runbook cannot do

- Cannot verify on hardware you do not have. The whole point is the user
  doing this on real metal.
- Does not provision Secure Boot. The ISO is built with `--uefi-secure-boot
  disable`. If the target machine has Secure Boot enforced and not toggleable,
  this ISO will not boot — disable Secure Boot in firmware or use the signed
  release once available.
- Does not test internal-disk install. v1 is USB-only.
