# UTM quickstart

UTM is a local developer convenience for macOS. It is not the CI target and does
not replace the QEMU/KVM smoke harness.

## Requires hardware/platform

- macOS with UTM installed.
- Intel Mac for native x86_64 virtualization of the current qcow2.
- Apple Silicon can emulate x86_64, but expect it to be much slower; native
  Apple Silicon virtualization would require an arm64 image, which this bundle
  does not produce yet.

Metadata generation does not require macOS or UTM:

```bash
cd packages/os/linux
vm/scripts/package-metadata.sh -- --target utm
```

## Import flow

1. Build or obtain `vm/disk-base.qcow2`.
2. Create a new UTM virtual machine.
3. Choose Linux, then import/use the existing disk image.
4. Set architecture to x86_64.
5. Allocate at least 4 GB RAM and 2 CPU cores.
6. Use NAT networking.
7. Boot the VM.

## Notes

- The metadata manifest reserves `vm/output/usbeliza.utm.zip` for a future
  exported UTM bundle.
- Until that exported bundle exists, use the qcow2 import flow above.
- Validate behavior with QEMU/KVM before treating a build as release-ready.
