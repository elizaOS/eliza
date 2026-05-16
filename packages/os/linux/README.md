# elizaOS Linux

This tree now contains the active elizaOS Linux distribution work:

```text
packages/os/linux/
├── README.md
├── LICENSES/
└── variants/
    └── milady-tails/   # elizaOS Live USB, based on Tails/live-build
```

The older root-level usbeliza prototype was removed from this branch. It
was a separate minimal kiosk/live-build experiment with its own agent,
Rust crates, VM harness, and scripts. The product direction for this PR is
the Tails-based **elizaOS Live USB** in
[`variants/milady-tails/`](./variants/milady-tails/): a full desktop live
OS that preserves the Tails boot/greeter/security model, brands the user
experience as elizaOS, and starts the bundled elizaOS app as the always-on
home surface.

Use the variant docs as the source of truth:

- [`variants/milady-tails/README.md`](./variants/milady-tails/README.md)
- [`variants/milady-tails/PLAN.md`](./variants/milady-tails/PLAN.md)
- [`variants/milady-tails/ROADMAP.md`](./variants/milady-tails/ROADMAP.md)
- [`variants/milady-tails/docs/production-readiness.md`](./variants/milady-tails/docs/production-readiness.md)
- [`variants/milady-tails/docs/distribution-and-updates.md`](./variants/milady-tails/docs/distribution-and-updates.md)
