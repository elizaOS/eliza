# Flatpak packaging status

The canonical desktop release workflow packages the already-built and tested
Electrobun Linux tree with
`packages/app-core/scripts/package-electrobun-flatpak.mjs`. The resulting
side-loadable `.flatpak` contains the same desktop runtime revision as the
AppImage, Debian, and RPM artifacts. It is installed and held through a
45-second launch-liveness check before release artifacts are uploaded.

On Linux, run the Electrobun build first and then use:

```bash
bun run --cwd packages/app-core build:flatpak:direct
```

The package is written under
`packages/app-core/platforms/electrobun/artifacts/`.

## Flathub is not yet eligible

The YAML manifests in this directory are retained only as evidence of the
retired CLI-based experiment. They install the `elizaos` command-line package,
not the Electrobun desktop application. The store manifest also requires
network access while building. Do not submit either manifest to Flathub or
treat a successful build as desktop acceptance.

`bun run --cwd packages/app-core build:flatpak:store` deliberately fails
closed. Before enabling it, all of the following must be true:

1. A human maintainer has resolved Flathub's generative-AI submission policy
   for this repository and obtained any required exception.
2. The manifest builds the real Electrobun application and all dependencies
   offline from immutable, checksum-pinned sources.
3. The selected reverse-DNS app ID is controlled and verified by the publisher.
4. Current AppStream metadata, screenshots, permissions, and portal behavior
   pass Flathub review and the official linter.
5. A human authors and submits the Flathub application materials. Automation
   may test the repository artifact, but it must not generate or submit the
   application on that person's behalf.

The two retired manifests are:

- `ai.elizaos.App.store.yml`: locked-down CLI experiment; not Flathub-ready.
- `ai.elizaos.App.yml`: host-access CLI experiment; not intended for Flathub.
