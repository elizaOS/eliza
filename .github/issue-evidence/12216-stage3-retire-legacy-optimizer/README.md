# Stage 3: retire legacy eliza1-optimized optimizer

Issue: #12320

This slice deletes `packages/training/scripts/optimize_for_eliza1.py` and
removes the `run_pipeline.py --eliza1-bundle` delegation that auto-produced the
retired `eliza1-optimized/` output when an elizaOS llama.cpp fork was present.
The supported Gemma path remains the manifest staging flow plus
`scripts.publish.orchestrator`.

Verification commands:

```bash
python3 -m pytest packages/training/scripts/test_hf_publish.py -q -k 'publish_all_ignores_retired_eliza1_optimized_bundle'
python3 -m pytest packages/training/scripts/test_train_nebius_smoke_all_tiers.py -q -k 'eliza1_bundle'
python3 -m py_compile packages/training/scripts/run_pipeline.py packages/training/scripts/publish_all_finetuned.py packages/training/scripts/emit_eliza1_catalog.py packages/training/scripts/verify_optimization_stack.py packages/training/scripts/publish/stage_base_v1_candidate.py
grep -RIn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.turbo --exclude-dir=dist --exclude-dir=.github -E 'optimize_for_eliza1|eliza1-optimized|--eliza1-bundle' packages/training/scripts packages/training/README.md packages/training/CLAUDE.md packages/training/AGENTS.md
cmp -s packages/training/CLAUDE.md packages/training/AGENTS.md
git diff --check origin/develop..HEAD
```

UI/screenshots/video: N/A. This change only removes training and publishing
script paths; it does not change app UI.
