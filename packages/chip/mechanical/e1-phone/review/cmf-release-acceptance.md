# E1 Phone CMF Release Acceptance

Status: blocked_no_cmf_results.

This review is fail-closed until hard-orange molded samples and CMF evidence are returned.

Template: `mechanical/e1-phone/review/cmf-results-template.csv`

## Criteria

- BLOCKED: `orange_resin_color_plaque_delta_e`
  Target: molded orange PC+ABS plaque within deltaE <= 2.0 against approved master chip
  Required artifact: color plaque photo, spectro reading, resin lot, and master-chip ID
- BLOCKED: `hard_touch_gloss_texture`
  Target: hard matte/satin orange texture approved with 8-18 GU at 60 deg and documented texture depth
  Required artifact: texture plaque, gloss-meter reading, and tool texture callout
- BLOCKED: `scratch_and_hand_oil_visibility`
  Target: no objectionable whitening, gloss change, or dark hand-oil staining on orange A-surfaces after rub/scratch exposure
  Required artifact: rub/scratch photos before and after, reviewer disposition, and cleaning method
- BLOCKED: `gate_blush_vestige_and_weld_line_visibility`
  Target: gate vestige off A-surface; no visible weld line on front rail, back hero surface, camera land, or USB lip
  Required artifact: first-shot photos, gate vestige measurement, weld-line overlay, and mold-flow reference
- PASS: `rendered_orange_identity_locked`
  Target: CAD review views show dominant orange shell with black glass front and compact phone slab proportions
  Required artifact: visual-review.json and visual-decision-report.json

## Release Rule

- Color plaque, texture/gloss plaque, scratch/rub sample, gate-blush/weld-line first-shot review, and rendered orange identity must all pass before industrial-design or CMF release.
