# Stage 4 27b-256k Publish Map Evidence

Issue: #12321

## Change Proven

- `publish/orchestrator.py` now includes `27b-256k` in both publish-time maps
  that were previously missing the tier:
  - `TIER_TAGLINES`
  - `DEFAULT_RAM_BUDGET_MB`
- `test_orchestrator.py` asserts the orchestrator maps cover the complete
  release tier matrix: `2b`, `4b`, `9b`, `27b`, `27b-256k`.

## Verification

Run from `/Users/shawwalters/eliza-stage4-27b-256k` on July 4, 2026:

```bash
python3 -m pytest packages/training/scripts/publish/test_orchestrator.py -q -k 'tier_maps_cover_release_matrix'
```

Result:

```text
.                                                                        [100%]
```

```bash
python3 -m pytest packages/training/scripts/publish/test_orchestrator.py -q
```

Result:

```text
....................................................                     [100%]
```

```bash
python3 -m py_compile \
  packages/training/scripts/publish/orchestrator.py \
  packages/training/scripts/publish/test_orchestrator.py
```

Result: exit code 0.

## Evidence Applicability

- Screenshots/video: N/A. This is a CLI publish-orchestrator metadata fix with
  no UI surface.
- Live LLM trajectory: N/A. This change does not alter agent behavior,
  prompts, actions, providers, or model outputs.
- Backend/frontend logs: N/A. The relevant observable artifact is the
  orchestrator no longer being able to KeyError on missing `27b-256k` map data.
