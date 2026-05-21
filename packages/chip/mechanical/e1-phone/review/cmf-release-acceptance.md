# E1 Phone CMF Release Acceptance

Status: blocked_no_cmf_results.

This gate blocks CMF release until molded orange samples and visual signoff are complete.

## Criteria

- BLOCKED: `orange_resin_color_plaque_delta_e`
  Required artifact: color plaque photo, spectro reading, resin lot, and master-chip ID
- BLOCKED: `hard_touch_gloss_texture`
  Required artifact: texture plaque, gloss-meter reading, and tool texture callout
- BLOCKED: `scratch_and_hand_oil_visibility`
  Required artifact: rub/scratch photos before and after, reviewer disposition, and cleaning method
- BLOCKED: `gate_blush_vestige_and_weld_line_visibility`
  Required artifact: first-shot photos, gate vestige measurement, weld-line overlay, and mold-flow reference
- PASS: `rendered_orange_identity_locked`
  Required artifact: visual-review.json and visual-decision-report.json

## Release Rule

- Color plaque, texture/gloss plaque, scratch/rub sample, gate-blush/weld-line first-shot review, physical numeric limits, evidence_class=physical_cmf_result, and rendered orange identity must all pass before industrial-design or CMF release.
