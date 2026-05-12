# Eliza-1 DFlash Catalog Handoff

After a real distillation run lands, the resulting `drafter-<tier>.gguf` files
must be referenced in the catalog. **Do not edit the catalog inline while
distillation work is in flight** — other agents may have pending changes.
This fragment shows what the catalog should look like, plus the diff that
must land per tier.

## Tier ID divergence — read first

There is an active divergence between the two sources of truth for tier IDs:

| Source                                                                          | Tier IDs                                                                       |
|---------------------------------------------------------------------------------|--------------------------------------------------------------------------------|
| `packages/shared/src/local-inference/catalog.ts` (`Eliza1TierId`)               | `eliza-1-0_6b`, `eliza-1-1_7b`, `eliza-1-4b`, `eliza-1-9b`, `eliza-1-27b`, `eliza-1-27b-256k`, `eliza-1-27b-1m` |
| `packages/training/scripts/distill_dflash_drafter.py` (`DEFAULT_STUDENT_BASE`)  | `0_8b`, `2b`, `4b`, `9b`, `27b`, `27b-256k`, `27b-1m`                          |
| `docs/ELIZA_1_GGUF_READINESS.md` (bundle file lists)                            | `0_8b`, `2b`, `4b`, `9b`, `27b`, `27b-256k`, `27b-1m`                          |

The catalog has `0_6b` and `1_7b` which do not exist in the distill script;
the distill script has `0_8b` and `2b` which do not exist in the catalog. This
must be reconciled **before** the first real distillation run lands — otherwise
the drafter file path in the catalog (`dflash/drafter-0_6b.gguf`) and the path
the distill script emits (`drafter-0_8b.gguf`) will not match.

Two ways to reconcile (decision needed from the platform owner):

1. **Catalog matches distill script.** Add the missing `0_8b` + `2b` tiers
   to the catalog and remove `0_6b` + `1_7b`. (Likely correct if upstream
   moved to Qwen3.5-0.8B + Qwen3.5-2B.)
2. **Distill script matches catalog.** Update `DEFAULT_STUDENT_BASE` /
   `DEFAULT_TARGET_MODEL` / `ACCEPTANCE_GATE` keys in `distill_dflash_drafter.py`
   to use `0_6b`, `1_7b`, `4b`, `9b`, `27b`, `27b-256k`, `27b-1m`. Update
   the job scripts under `scripts/dflash/jobs/` to match. (Likely correct
   if the bundle layout in `ELIZA_1_GGUF_READINESS.md` is stale.)

The fragment below assumes option 1 (catalog → distill IDs) because the
distill script's tier set is what the bundle file layout and the publish
gate are wired against.

## Per-tier catalog patch (after real drafter lands)

For each tier in `{0_8b, 2b, 4b, 9b, 27b, 27b-256k, 27b-1m}`, ensure the
catalog has both a chat model and a paired drafter companion. The drafter
companion must reference `dflash/drafter-<tier>.gguf`, declare
`runtimeRole: "dflash-drafter"`, and share `tokenizerFamily: "qwen35"` with
the chat model.

The fragments below are the **target state** in catalog.ts; apply them as
diffs once the corresponding `drafter-<tier>.gguf` is built and validated.

```ts
// 0_8b — replaces the current eliza-1-0_6b chat+drafter pair
{
  id: "eliza-1-0_8b",
  displayName: "eliza-1-0_8b",
  hfRepo: "elizaos/eliza-1-0_8b",
  ggufFile: "text/eliza-1-0_8b-32k.gguf",
  bundleManifestFile: "eliza-1.manifest.json",
  params: "0.8B",
  quant: "Eliza-1 optimized local runtime",
  sizeGb: 0.85,
  minRamGb: 2,
  category: "chat",
  bucket: "small",
  contextLength: 32768,
  tokenizerFamily: "qwen35",
  companionModelIds: ["eliza-1-0_8b-drafter"],
  // ...
},
drafterCompanion({
  id: "eliza-1-0_8b",
  ggufFile: "dflash/drafter-0_8b.gguf",
  params: "0.8B",  // self-size drafter for the smallest tier
  sizeGb: 0.4,
  minRamGb: 2,
  bucket: "small",
}),

// 2b — net-new entry (no current catalog row)
{
  id: "eliza-1-2b",
  displayName: "eliza-1-2b",
  hfRepo: "elizaos/eliza-1-2b",
  ggufFile: "text/eliza-1-2b-32k.gguf",
  // ...
  companionModelIds: ["eliza-1-2b-drafter"],
},
drafterCompanion({
  id: "eliza-1-2b",
  ggufFile: "dflash/drafter-2b.gguf",
  params: "0.8B",  // student is Qwen3.5-0.8B
  sizeGb: 0.4,
  minRamGb: 4,
  bucket: "small",
}),

// 4b — drafter path is `dflash/drafter-4b.gguf`, student is Qwen3.5-0.8B
drafterCompanion({
  id: "eliza-1-4b",
  ggufFile: "dflash/drafter-4b.gguf",
  params: "0.8B",
  sizeGb: 0.4,
  minRamGb: 8,
  bucket: "mid",
}),

// 9b — student is Qwen3.5-2B
drafterCompanion({
  id: "eliza-1-9b",
  ggufFile: "dflash/drafter-9b.gguf",
  params: "2B",
  sizeGb: 1.0,
  minRamGb: 12,
  bucket: "mid",
}),

// 27b / 27b-256k / 27b-1m — student is Qwen3.5-4B; same drafter recipe
// shared across the three context variants. Each context variant should
// validate separately to confirm the drafter's
// `dflash-draft.target_checkpoint_sha256` matches the right text GGUF.
drafterCompanion({
  id: "eliza-1-27b",
  ggufFile: "dflash/drafter-27b.gguf",
  params: "4B",
  sizeGb: 2.0,
  minRamGb: 24,
  bucket: "large",
}),
drafterCompanion({
  id: "eliza-1-27b-256k",
  ggufFile: "dflash/drafter-27b-256k.gguf",
  params: "4B",
  sizeGb: 2.0,
  minRamGb: 24,
  bucket: "large",
}),
drafterCompanion({
  id: "eliza-1-27b-1m",
  ggufFile: "dflash/drafter-27b-1m.gguf",
  params: "4B",
  sizeGb: 2.0,
  minRamGb: 24,
  bucket: "large",
}),
```

## Verification before merging the catalog change

For each tier touched:

1. `validate_drafter.py` exit code is `0` on the new drafter.
2. The drafter's `dflash-draft.target_checkpoint_sha256` matches the sha256
   of the text GGUF the catalog references (`ggufFile` on the chat row).
3. `evals/aggregate.json` for the tier records the measured acceptance
   window (this lives in the bundle, not the catalog — the catalog only
   references the bundle by `bundleManifestFile`).
4. `bun run --cwd packages/shared test` passes (catalog typecheck).
