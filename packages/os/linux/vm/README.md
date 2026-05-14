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
├── scripts/
│   ├── build-base.sh            # produces disk-base.qcow2 via mmdebstrap (slow; cached locally + nightly in CI)
│   ├── boot.sh                  # qemu-system-x86_64 -snapshot -enable-kvm -display none ...
│   ├── deploy.sh                # rsync current build artifacts into a running VM (dev only)
│   ├── inject.py                # virtio-serial input + QMP screenshot capture + assertion DSL
│   ├── run-tests.sh             # ties boot+inject together for `just vm-test`
│   └── teardown.sh
├── snapshots/                   # gitignored; created by `vm-up`
└── README.md                    # this file
```

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
