# elizaOS Linux

This tree now contains the active elizaOS Linux distribution work:

```text
packages/os/linux/
├── README.md
├── LICENSES/
└── variants/
    └── eliza-tails/   # elizaOS Live USB, based on Tails/live-build
```

The older root-level usbeliza prototype was removed from this branch. It
was a separate minimal kiosk/live-build experiment with its own agent,
Rust crates, VM harness, and scripts. The product direction for this PR is
the Tails-based **elizaOS Live USB** in
[`variants/eliza-tails/`](./variants/eliza-tails/): a full desktop live
OS that preserves the Tails boot/greeter/security model, brands the user
experience as elizaOS, and starts the bundled elizaOS app as the always-on
home surface.

Use the variant docs as the source of truth:

- [`variants/eliza-tails/README.md`](./variants/eliza-tails/README.md)
- [`variants/eliza-tails/PLAN.md`](./variants/eliza-tails/PLAN.md)
- [`variants/eliza-tails/ROADMAP.md`](./variants/eliza-tails/ROADMAP.md)
- [`variants/eliza-tails/docs/production-readiness.md`](./variants/eliza-tails/docs/production-readiness.md)
- [`variants/eliza-tails/docs/security-model.md`](./variants/eliza-tails/docs/security-model.md)
- [`variants/eliza-tails/docs/runtime-packaging.md`](./variants/eliza-tails/docs/runtime-packaging.md)
- [`variants/eliza-tails/docs/inherited-tails-sudoers-review.md`](./variants/eliza-tails/docs/inherited-tails-sudoers-review.md)
- [`variants/eliza-tails/docs/distribution-and-updates.md`](./variants/eliza-tails/docs/distribution-and-updates.md)
