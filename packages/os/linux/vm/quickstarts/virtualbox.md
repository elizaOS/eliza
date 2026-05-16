# VirtualBox quickstart

VirtualBox is a compatibility target for manual developer checks. It is not the
canonical smoke-test harness.

## Requires hardware/platform

- VirtualBox installed on an x86_64 host.
- Hardware virtualization enabled in firmware: VT-x on Intel or AMD-V on AMD.
- A converted disk or OVA. The current build path produces `disk-base.qcow2`;
  VirtualBox normally uses VDI/VMDK or imports OVA appliances.

Metadata generation does not require VirtualBox or an OVA:

```bash
cd packages/os/linux
vm/scripts/package-metadata.sh -- --target virtualbox
```

## Convert and boot

```bash
cd packages/os/linux
qemu-img convert -O vdi vm/disk-base.qcow2 vm/output/usbeliza.vdi
```

Then in VirtualBox:

1. Create a Linux Debian 64-bit VM.
2. Allocate at least 4 GB RAM and 2 CPU cores.
3. Attach `vm/output/usbeliza.vdi` as the primary disk.
4. Use NAT networking.
5. Boot the VM.

## Notes

- The metadata manifest reserves `vm/output/usbeliza-virtualbox.ova` for a
  future exported appliance.
- This x86_64 appliance is not a native Apple Silicon VirtualBox target.
- QEMU/KVM remains the release-readiness gate.
