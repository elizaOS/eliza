#!/usr/bin/env sh
set -eu

RUN_ID="${1:-validation}"
OUT_DIR="build/ai_eda/openroad_autotuner/${RUN_ID}"
MANIFEST="${OUT_DIR}/autotune_manifest.json"
mkdir -p "${OUT_DIR}"

cat >"${MANIFEST}" <<JSON
{
  "schema": "eliza.ai_eda.openroad_autotuner_manifest.v1",
  "run_id": "${RUN_ID}",
  "mode": "dry-run",
  "status": "DRY_RUN_NOT_EXECUTED",
  "claim_boundary": "no_ppa_claim_no_signoff_claim_no_ai_output_as_evidence",
  "source_ids": [
    "autoeda-mcp",
    "autodmp",
    "circuitnet",
    "circuitnet-2",
    "routeplacer"
  ],
  "executes_openlane": false,
  "external_api_keys_required": false,
  "candidate_parameters": [
    "FP_CORE_UTIL",
    "PL_TARGET_DENSITY",
    "GRT_ADJUSTMENT",
    "PL_RESIZER_HOLD_SLACK_MARGIN"
  ],
  "required_followup_gates": [
    "make openlane-run-preflight-check",
    "make pd-signoff-manifest-check",
    "make synth"
  ],
  "blocked_by": [
    "completed OpenLane baseline run",
    "archived input design hashes",
    "defined objective function",
    "held-out validation runs for any predictor"
  ]
}
JSON

echo "STATUS: PASS ai_eda.openroad_autotuner.dry_run ${MANIFEST}"
