# meta-elizaos: elizaos-agent recipe (placeholder)

Status: **BLOCKED** on a Yocto/meta-dstack build host (gate
`confidential-image-reproducibility`). This is a scaffold marker, not a working
recipe — there is no `.bb` here yet because there is no build host to validate
it against. Adding a non-building `.bb` would be larp.

When a build host exists, this recipe will bake into the measured rootfs:

1. the elizaOS agent container image (`@elizaos/agent` + app-core + local
   inference) — measured into `agent` / `container` / `compose`,
2. the in-domain attestation agent (dstack-guest-agent / tappd equivalent) that
   produces the runtime quote consumed by
   `packages/os/scripts/tee-evidence-bridge.mjs`,
3. the TEE policy blob (`../../../policy/confidential-policy.json`) — measured
   into `policy`,
4. dm-crypt / disk tooling for the sealed `MILADY_STATE_DIR` volume.

Each component digest is recorded in the image manifest so a verifier can
recompute the golden `os` / `agent` / `policy` / `compose` digests offline. The
image-manifest schema is shared with the chip lane
(`packages/chip/docs/security/tee-plan/06-os-on-tee-software.md` WI-3).

Proving command once unblocked:

```
# inside the meta-dstack repro-build context
bitbake elizaos-confidential-image
# then: node packages/os/scripts/generate-tee-measurements.mjs \
#   --boot <kernel+ovmf> --os <rootfs> --agent <agent-image> \
#   --policy ../../../policy/confidential-policy.json --compose <app-compose.json> ...
```
