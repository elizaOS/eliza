# Eliza-1 DFlash Drafter Strategy On AOSP

## Current Decision

The AOSP local inference path is Eliza-1 only. Runtime catalogs,
download staging, bundled defaults, and DFlash companion selection must
point at `elizaos/eliza-1-*` GGUF artifacts produced by the Eliza-1
publish pipeline.

DFlash target and drafter artifacts must share the Eliza-1 tokenizer
family. The runner should never repair or reinterpret another model
family's tokenizer metadata at load time; mismatched vocabularies fail
speculative decoding by construction and produce zero useful acceptance.

## Retired Pairing

Older notes proposed external target/drafter combinations and tokenizer
repair. That plan is superseded. The accepted path is:

- Target: an Eliza-1 fused GGUF for the device tier.
- Drafter: an Eliza-1 drafter GGUF generated and published with the same
  tokenizer family.
- Source: Hugging Face repos under `elizaos/eliza-1-*`.
- Runtime: the custom `milady-ai/llama.cpp` fork with the shipped DFlash
  and fused KV-cache support.

## Catalog Rules

Every visible local model catalog entry should be an Eliza-1 tier. Any
hidden DFlash companion entry must be an Eliza-1 companion for a visible
Eliza-1 target and must resolve through the same catalog, download, and
bundled-model paths as the target.

The catalog test should continue to enforce:

- Every `runtime.dflash.drafterModelId` resolves to a real catalog entry.
- Target and drafter share the same tokenizer family.
- Non-Eliza-1 HF search results are not promoted into the default local
  model catalog.

## AOSP Behavior

AOSP staging should download only the selected Eliza-1 tier artifacts and
their declared companions. Model-specific KV-cache behavior comes from
catalog runtime metadata or explicit environment overrides, not filename
heuristics for retired external model names.

The smoke path remains:

1. Cross-compile the unified `llama-server`/`libllama` artifacts for the
   target ABI.
2. Stage the Eliza-1 target GGUF and any Eliza-1 DFlash companion GGUF.
3. Start local inference with `ELIZA_DFLASH=1`.
4. Verify `/health`, one chat-completion round trip, and non-zero
   `n_drafted_total` plus a useful accepted/drafted ratio.

## Publishing Dependency

This strategy depends on the Eliza-1 publish pipeline producing the
device-tier GGUF bundles first. Until those repos exist on Hugging Face,
the app should fail fast with a clear missing-artifact/download error
rather than silently falling back to another model family.
