# VM harness

> Status: scaffold (skeleton). Implementation in milestone #9.

The `vm/` tree holds the reproducible QEMU/KVM test harness used to prove Phase 0+
behavior end-to-end. The harness is **headless from day 1** (locked decision #3) so
the same recipes run interactively for dev and unattended in CI.

## Layout (target)

```
vm/
├── disk-base/
│   ├── mmdebstrap.recipe        # declarative base image build
│   └── overlay/                 # files copied in (sway config, systemd units, eliza binaries)
├── quickstarts/
│   ├── qemu.md                  # canonical QEMU/KVM flow
│   ├── utm.md                   # macOS UTM import notes
│   └── virtualbox.md            # VirtualBox conversion/import notes
├── scripts/
│   ├── build-base.sh            # produces disk-base.qcow2 via mmdebstrap (slow; cached locally + nightly in CI)
│   ├── boot.sh                  # qemu-system-x86_64 -snapshot -enable-kvm -display none ...
│   ├── deploy.sh                # rsync current build artifacts into a running VM (dev only)
│   ├── generate-bundle-metadata.py # writes manifest/package metadata, even without images
│   ├── inject.py                # virtio-serial input + QMP screenshot capture + assertion DSL
│   ├── package-metadata.sh      # wrapper for metadata generation and optional metadata tarball
│   ├── run-tests.sh             # ties boot+inject together for `just vm-test`
│   └── teardown.sh
├── snapshots/                   # gitignored; created by `vm-up`
├── output/                      # gitignored; generated metadata and converted VM artifacts
├── tests/                       # metadata tests that do not boot a VM
└── README.md                    # this file
```

## Bundle metadata

The VM bundle metadata path is intentionally image-optional. This lets CI and
release automation validate the manifest shape before a slow qcow2, UTM, or
VirtualBox appliance exists.

```bash
cd packages/os/linux
vm/scripts/package-metadata.sh
python3 -m unittest discover -s vm/tests
```

Generated files land in `vm/output/bundle-metadata/` by default:

- `manifest.json` — selected VM targets, artifact paths, sizes/checksums when
  files exist, hardware requirements, and quickstart links.
- `package-metadata.json` — metadata files and image files expected in a
  distributable bundle.

Use `--require-images` only in release jobs that should fail when the selected
VM image artifacts are missing:

```bash
cd packages/os/linux
vm/scripts/package-metadata.sh -- --target qemu --require-images
```

Platform-specific quickstarts:

- [QEMU](quickstarts/qemu.md) — canonical Linux x86_64 QEMU/KVM harness.
- [UTM](quickstarts/utm.md) — macOS import path; Intel Mac is the practical
  x86_64 virtualization target, Apple Silicon is emulation-only for this image.
- [VirtualBox](quickstarts/virtualbox.md) — x86_64 host with VT-x/AMD-V and a
  converted disk or future OVA.

## Determinism rules

- `claude` calls are not deterministic; tests assert on **behavior** (window opens,
  manifest exists, sandbox enforced) — never on exact LLM output bytes.
- Snapshot-restore between tests guarantees a clean slate. No "test-A leaks state into test-B" surprises.
- The base qcow2 is built deterministically from `mmdebstrap.recipe`; the recipe itself
  is the source of truth for what's in the image.

## Why headless

If the harness needs a human to click "OK" on a dialog, it doesn't run in CI, which
means it doesn't run, which means regressions slip in. Past lesson learned the hard
way (see `feedback_clean_code` memory): "verified" must mean "actually exercised in CI."
