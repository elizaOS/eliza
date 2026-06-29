# Issue 10096 — Linux ISO GHA cache contract evidence

Scope: adds a CPU-light contract test proving `packages/os/linux/build.sh`
switches from plain `docker build` to `docker buildx build` with GitHub Actions
layer-cache flags when `ELIZAOS_DOCKER_BUILDX_GHA_CACHE=1` is set. The test is
wired into the existing Linux ISO `static-smoke.sh` path.

Manual review:

- Confirmed the cache-off path invokes plain
  `docker build --platform linux/amd64 --build-arg TARGETARCH=amd64 ...`.
- Confirmed the cache-on path checks `docker buildx version`.
- Confirmed the cache-on path invokes
  `docker buildx build --load --cache-from type=gha,scope=contract-scope --cache-to type=gha,scope=contract-scope,mode=max ...`.
- Confirmed the test uses a temporary Tails source and fake Docker binary, so it
  validates command construction without building an image or reaching the
  network.

Verification:

```bash
bash packages/os/linux/scripts/build-cache-contract.test.sh
# build.sh Docker cache contract OK

ELIZAOS_STATIC_SOURCE_ONLY=1 bash packages/os/linux/scripts/static-smoke.sh
# ==> shell syntax
# build.sh Docker cache contract OK
# ...
# static smoke passed
```

Evidence marked N/A:

- UI screenshots/video: N/A, no UI change.
- Live LLM trajectory: N/A, no prompt/model/agent behavior change.
- Native device capture: N/A for this contract-test PR. Full ISO cache-hit and
  no-regression proof still requires the GitHub Actions runner path and is
  expected from the PR checks / release workflow run.
