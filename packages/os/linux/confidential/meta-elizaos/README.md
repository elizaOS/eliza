# meta-elizaos — elizaOS confidential-profile Yocto layer

Status: **layer is real and parseable; the full image build is BLOCKED** on a
Yocto/meta-dstack build host (gate `confidential-image-reproducibility`).

This is the elizaOS Yocto layer for `ELIZAOS_PROFILE=confidential`
(`packages/os/docs/tee-os-implementation-plan.md` §1.3 / OS-1). It is composed
alongside vendored `meta-dstack` + `poky` in the repro-build context.

## What is real here

- `conf/layer.conf` — valid OE layer config: `BBFILE_COLLECTIONS`,
  `BBFILE_PATTERN_meta-elizaos`, `BBFILE_PRIORITY_meta-elizaos`,
  `LAYERDEPENDS_meta-elizaos`, `LAYERSERIES_COMPAT_meta-elizaos`. Parseable by
  bitbake on a build host.
- `recipes-elizaos/elizaos-confidential-profile/elizaos-confidential-profile.bb`
  — a real, non-larp recipe. Its `SRC_URI` references **only files that exist
  in-tree** (the TEE policy blob, the golden image manifest, and the GAP-2
  enforcement artifacts: `cmdline.conf`, `sysctl.d/99-confidential.conf`,
  `masked-units.txt`). `do_install` stages them into the rootfs under
  `/etc/elizaos/...`, installs the sysctl drop-in into `/etc/sysctl.d/`, and
  masks each listed systemd unit by symlinking it to `/dev/null`. This recipe
  needs no network fetch and no compile step, so its `do_install` is exercisable
  byte-for-byte once a build host parses the layer.

`check-confidential-layer.mjs` validates the layer.conf required directives and
asserts every `file://` source the recipe references actually exists in-tree —
fail-closed if a recipe points at a missing file.

## What is BLOCKED (and honestly NOT written as a recipe)

The agent container image, the in-domain attestation agent
(dstack-guest-agent / tappd equivalent), and the dm-crypt/LUKS2 sealed-volume
tooling are **not** shipped as `.bb` files here. They depend on build artifacts
that do not exist in this checkout (a baked `@elizaos/agent` container image, a
cross-compiled attestation agent). Writing recipes that fetch nonexistent
artifacts would be larp, so they are documented here as build-host-blocked
rather than stubbed. See `recipes-elizaos/elizaos-agent/README.md`.

| Item | Gate | Missing dependency |
| --- | --- | --- |
| Agent container image recipe | `confidential-image-reproducibility` | baked `@elizaos/agent` container image |
| In-domain attestation agent recipe | `tdx-cvm-boot-smoke` | cross-compiled tappd-equivalent + TDX host |
| Full `bitbake elizaos-confidential-image` | `confidential-image-reproducibility` | vendored meta-dstack + Yocto build host |
