# Stage 4: HF audit text architecture gate

Issue: #12321

This slice makes the metadata-only Hugging Face release audit enforce the text
architecture recorded in each bundle manifest. Every `files.text` entry must
carry a non-empty `architecture` value and it must be Gemma-family
(`gemma*`). A qwen35 text artifact recorded in the manifest now fails the HF
release audit instead of passing through as a Gemma bundle.

Verification commands:

```bash
python3 -m pytest packages/training/scripts/manifest/test_audit_hf_eliza1_release.py -q -k 'complete_hf_release_audit_passes or non_gemma_manifest_text_architecture or missing_manifest_text_context_variant or wrong_manifest_text_context_value or requires_quantization_sidecars'
python3 -m py_compile packages/training/scripts/manifest/audit_hf_eliza1_release.py packages/training/scripts/manifest/test_audit_hf_eliza1_release.py
git diff --check origin/develop..HEAD
```

UI/screenshots/video: N/A. This change only affects release-audit metadata
checks and tests.
