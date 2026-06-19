# Confidential image repro-build context (OS-5)

Status: **BLOCKED on a build host.** meta-dstack is **not vendored** here yet and
there is no Yocto/bitbake toolchain or TDX build host in this environment, so the
multi-hour reproducible image build cannot run locally. This directory is the
**contract**: the exact pin and invocation OS-5 needs once a build host exists.
The reproducibility property itself (double-build digest equality + offline
recompute of declared component digests) is provable now and is exercised by
`packages/os/scripts/verify-image-reproducibility.mjs` and its tests against
deterministic fixtures.

Gate: `confidential-image-reproducibility` (plan §1.3/§2.2, §7.2 OS-5).

## What "reproducible" means here

Rebuilding the confidential guest image from the pinned inputs must yield
**byte-identical** components (kernel / initrd / rootfs / app-compose), hence
identical RTMR1/RTMR2/rootfs-hash/RTMR3 measurements, hence the same signed golden
`tee-measurements.json`. A relying party then recomputes the golden digests
offline and never has to trust the builder. "The image is the policy."

## Pins required on the build host

These must be vendored under `packages/os/linux/confidential/` (pinned by commit)
before the build can be called reproducible. They are recorded in the image
manifest `buildInputs.layers[]` / `buildInputs.toolchain[]` so the verifier can
assert the build used exactly these inputs:

| Layer | Repo | Pin field |
| --- | --- | --- |
| meta-dstack | https://github.com/Dstack-TEE/meta-dstack | `buildInputs.layers[].commit` |
| poky | https://git.yoctoproject.org/poky (scarthgap) | `buildInputs.toolchain[].sha256` |
| meta-virtualization | https://git.yoctoproject.org/meta-virtualization | `buildInputs.layers[].commit` |
| meta-security | https://git.yoctoproject.org/meta-security | `buildInputs.layers[].commit` |
| meta-elizaos | packages/os/linux/confidential/meta-elizaos | `buildInputs.layers[].commit` |

`meta-dstack` ships `repro-build/repro-build.sh`, a pinned Docker context that
freezes the host toolchain so the build is deterministic regardless of the build
machine.

## Invocation (once meta-dstack is vendored + a build host is available)

```sh
# 1. Vendor + pin meta-dstack and its upstream layers under
#    packages/os/linux/confidential/ (git submodules pinned by commit).
# 2. Run the upstream pinned repro-build twice on independent hosts/clean trees:
meta-dstack/repro-build/repro-build.sh   # build A
meta-dstack/repro-build/repro-build.sh   # build B (separate clean checkout)

# 3. Generate an image manifest from each build's output components:
node packages/os/scripts/generate-tee-measurements.mjs ...  # golden measurements
#    (emit one confidential-image-manifest per build: build-a.json, build-b.json)

# 4. Assert the two builds are byte-identical (the core reproducibility property):
node packages/os/scripts/verify-image-reproducibility.mjs \
  --build-a build-a.json --build-b build-b.json \
  --components-dir-a buildA/images --components-dir-b buildB/images

# 5. Recompute the shipped golden manifest's component digests from real bytes:
node packages/os/scripts/verify-image-reproducibility.mjs \
  --input packages/os/linux/confidential/image-manifest.example.json \
  --components-dir buildA/images

# 6. Flip reproducibility.confirmed to true (with reproBuildContext set) only
#    after steps 4 + 5 pass. The verifier then requires real-byte recompute and
#    will hard-FAIL a confirmed=true manifest with no backing bytes.
```

Until step 6, `reproducibility.confirmed` stays **false** and the gate reports
**BLOCKED** (exit 3) — correct data, not production-ready — never a hard failure
and never a fabricated "reproducible" claim.
