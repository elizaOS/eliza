# meta-elizaos: elizaos-agent recipe (BLOCKED on a build host)

Status: **BLOCKED** on a Yocto/meta-dstack build host (gate
`confidential-image-reproducibility`). There is intentionally **no `.bb` here**:
this recipe would bake the agent **container image** and the cross-compiled
**in-domain attestation agent**, neither of which exists as a fetchable artifact
in this checkout. Writing a `.bb` that fetches a nonexistent image would be larp,
so it is documented as build-host-blocked instead of stubbed.

The static, in-tree parts of OS-1/OS-3 that DO exist — the TEE policy blob, the
golden image manifest, and the GAP-2 enforcement artifacts (cmdline / sysctl /
masked-units) — are installed by the real, parseable recipe
`../elizaos-confidential-profile/elizaos-confidential-profile.bb`, whose
`do_install` references only files that exist.

When a build host exists, the recipe in this directory will bake into the
measured rootfs:

1. the elizaOS agent container image (`@elizaos/agent` + app-core + local
   inference) — measured into `agent` / `container` / `compose`,
2. the in-domain attestation agent (dstack-guest-agent / tappd equivalent) that
   produces the runtime quote consumed by
   `packages/os/scripts/tee-evidence-bridge.mjs`,
3. dm-crypt / disk tooling for the sealed `MILADY_STATE_DIR` volume.

The TEE policy blob (`../../../policy/confidential-policy.json`) is already
installed by the `elizaos-confidential-profile` recipe above.

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
