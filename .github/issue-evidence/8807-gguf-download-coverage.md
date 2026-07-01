# #8807 GGUF download coverage evidence

Date: 2026-07-01
Branch: `fix/mac-local-inference-tests`

## Scope Review

#8807's kept post-#9033 scope is already present on `develop`: GGUF magic rejection, disk preflight, retry/resume, and cloud HF-proxy routing.

This branch fixes a test-fixture gap found after rebasing onto the latest `origin/develop`: several bundle tests were accidentally using the host's real model-volume free disk value, so on this Mac's low free-disk state the disk preflight fired before the manifest/backend/RAM/verify behavior those tests intended to cover. Those tests now pass an explicit roomy `fakeProbe(100)` while the dedicated low-disk preflight test still uses the low-space fixture.

## Verification

Command:

```bash
NODE_OPTIONS='--experimental-sqlite' bunx vitest run plugins/plugin-local-inference/src/services/downloader.test.ts plugins/plugin-local-inference/src/local-inference-routes.test.ts
```

Result:

```text
Test Files  2 passed (2)
Tests       20 passed (20)
```

Manual review: the covered tests include non-GGUF/HTML-body rejection, disk-space preflight, cloud HF-proxy bearer forwarding, HuggingFace redirect auth handling, and deterministic manifest/backend/RAM/verify-hook failure paths that no longer depend on the developer machine's free disk.

## Evidence Applicability

- Screenshots/video: N/A. Download integrity and route-header coverage only; no UI changes.
- Real-LLM trajectory: N/A.
- Live cloud HF-proxy production validation: not claimed here. The remaining #8807 thread items require deployed Cloud Worker secret/config validation outside this local Mac checkout.
