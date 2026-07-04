# Stage 4 Publish HF Audit Gate Evidence

Issue: #12321

PR scope:

- Wire the metadata-only HF release audit into the non-dry-run publish orchestrator after final release evidence upload and before local release tagging.
- Block a real publish with `EXIT_HF_AUDIT_FAIL` if the published Hub surface is not green.
- Keep `--dry-run` deterministic and local-only because no Hub upload exists for the audit to inspect.

Verification:

```bash
python3 -m pytest packages/training/scripts/publish/test_orchestrator.py -q -k 'real_publish_finalizes_and_uploads_hf_evidence or real_publish_blocks_when_hf_release_audit_fails or real_base_v1_publish_rejects_retired_qwen_asr_provenance'
# ... [100%] 3 passed

python3 -m pytest packages/training/scripts/publish/test_orchestrator.py -q
# ..................................................... [100%] 53 passed

python3 -m py_compile packages/training/scripts/publish/orchestrator.py packages/training/scripts/publish/test_orchestrator.py
# passed
```
