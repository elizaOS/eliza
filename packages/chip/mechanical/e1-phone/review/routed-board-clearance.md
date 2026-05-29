# E1 Phone Routed Board Clearance

Status: blocked_waiting_for_physical_routed_board_clearance_result.

Template: `mechanical/e1-phone/review/routed-board-clearance-results-template.csv`

## Cases

- BLOCKED: `routed_board_step_available_for_import`
- PASS: `concept_pcb_step_not_release_evidence`
- PASS: `development_routed_step_available_for_local_review`
- PASS: `height_critical_components_have_cad_envelopes`
- PASS: `clearance_rerun_cases_defined`
- BLOCKED: `routed_step_clearance_results_present`

## Release Rule

- Routed-board clearance passes only after routed KiCad STEP is available, all height-critical component models are present, every rerun case is measured, every minimum gap is met, every interference count is zero, and evidence_class=physical_routed_board_clearance_result.
