# E1 Phone Visual Decision Report

Status: pass.
Automated visual status: automated_visual_coverage_pass.
Production visual signoff: blocked_manual_visual_review_open.

This report records the EVT0 CAD visual decisions and the manual review items still open.

## Decisions

- `compact_orange_shell`: keep; Hold 78.0 x 153.6 x 11.8 mm envelope around commodity touch panel with 0.45 mm minimum nominal screen margin.
- `black_bonded_glass_front`: keep; Black cover glass remains a separate bonded part over the display stack.
- `under_glass_front_camera_and_earpiece`: keep_for_evt0; Front camera and earpiece are represented behind glass/acoustic gasketing for CAD packaging.
- `rear_camera_cover_window`: keep_for_evt0; Single rear AF camera is buried under the flat back wall behind an explicit molded shell aperture and flush cover window (no bump, no proud ring); device depth was raised to fully bury the module.
- `bottom_io_pattern`: keep_for_evt0; USB-C insertion envelope, speaker slots, and microphone ports are modeled for mechanical review.
- `component_and_service_layout`: keep_for_evt0; PCB, battery, haptic, SIM keepout, RF keepouts, shields, cameras, and audio parts are indexed.
- `injection_mold_tooling_placeholders`: keep_for_dfm_discussion; Runner, submarine gates, ejector pins, cooling channels, and parting plane are CAD placeholders.

## Reviewed Views

- PASS: `component-review-audio.png` - speaker, earpiece, microphone, acoustic mesh, and port packaging
- PASS: `component-review-io-buttons.png` - USB-C, side buttons, seals, and tactile actuation packaging
- PASS: `component-review-optical.png` - front/rear cameras, flash, baffles, cover windows, and optical seals
- PASS: `component_stack.png` - PCB, battery, camera, audio, haptic, and I/O placement
- PASS: `exploded_iso.png` - glass, display, shell, and component stack separation
- PASS: `full_back_iso.png` - rear-side orange shell, camera window, and service-feature review
- PASS: `full_bottom_port.png` - USB-C, speaker grille, and microphone aperture review
- PASS: `full_front_iso.png` - front silhouette, orange side rail, black glass stack
- PASS: `full_left_side.png` - left-side button protrusion and shell depth
- PASS: `full_top_down.png` - compact footprint, screen margin, buttons, and front features
- PASS: `mold_tooling.png` - parting plane, runner, gate, ejector, and cooling placeholders
- PASS: `rear_feature_detail.png` - translucent rear shell review of camera window, SIM edge, and service-label recess

## Visual Design Gates

- PASS: `expected_review_view_coverage`
- PASS: `hard_orange_shell_visible`
- PASS: `black_glass_front_visible`
- PASS: `component_stack_visible`
- PASS: `component_family_detail_views`
- PASS: `compact_screen_margin`

## Manual Review Items

- Inspect rear feature proportions in GLB/STEP before CMF lock; render distinctness is an automated coverage check, not industrial-design approval.
- Confirm orange resin color, gloss, texture, knit lines, gate blush, and scratch behavior with molded samples.
- Validate camera-window aesthetics, lens stack height, dust gasket, and service label placement using supplier samples.
- Run tactile reviews for button travel, rattle, switch force, and snap-hook fatigue on physical samples.
- Replace mesh-derived review with real supplier STEP/B-rep data and routed KiCad board STEP before tooling release.

## Release Rule

- Automated render coverage may pass with generated nonblank views, but production visual/CMF signoff requires zero open manual review items, supplier STEP/B-rep review, molded orange resin CMF samples, and physical tactile/aesthetic review.
