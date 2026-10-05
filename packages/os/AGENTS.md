# elizaOS operating-system tooling

Linux images, Android vendor overlays, and USB/device installers. Follow the root
repository guide and the nearest installer guide. Application runtime sources
belong to `packages/app`; use `scripts/eliza-source.ts` to resolve their checkout.

Build and validation entrypoints: [README.md](README.md). Configuration checks are
not boot or installation evidence. Test destructive disk operations only against
explicitly allocated disposable images or virtual machines.
