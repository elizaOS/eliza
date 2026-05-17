---
name: ada-plan-view-accessibility
description: Use when checking simplified ADA-derived plan-view bathroom accessibility constraints such as turning space, door clear width, toilet centerline, grab bars, and lavatory knee/toe clearance.
---

Use this skill for plan-view accessibility checks. It is not a full legal ADA compliance review; apply only the geometric rules provided by the task.

## Plan-View Checks

- Door clear opening: compare the submitted clear width against the minimum in the rules file, commonly 32 inches.
- Door swing: if the rule disallows swing into required fixture clearance, prefer an outward or sliding swing in the repaired layout. Do not leave an inward repaired swing unless you have explicitly modeled and cleared the swing path against fixtures and required clearances.
- Turning space: verify that a 60 inch diameter circle fits inside usable floor area. Diameter alone is not enough. Apply the wall/boundary offset from the rules, subtract protected or blocked fixtures such as tubs, and allow overlap with toilet clear floor space only when the rules say so.
- Lavatory overlap: allow the turning circle to overlap a lavatory only when plan-view knee/toe clearance is explicitly indicated and meets the required width and depth.
- Toilet centerline: measure from the adjacent side wall and keep it inside the rule range, commonly 16 to 18 inches.
- Grab bars: classify rear-wall and side-wall bars by orientation/location and compare their plan-view lengths against the minimums. The side-wall grab bar should align with the same adjacent side wall used for the toilet centerline and overlap the toilet use zone. The rear-wall grab bar should align with the rear wall behind the toilet and cross or closely span the toilet centerline.

## Violation Reporting

Report one violation per failed rule/element pair. Use stable machine-readable rule names from the rules file, for example:

- `door_clear_width_min`
- `turning_circle_diameter_min`
- `turning_circle_fit_usable_floor`
- `toilet_centerline_from_side_wall_range`
- `side_grab_bar_length_min`
- `rear_grab_bar_length_min`
- `side_grab_bar_toilet_side_wall_alignment`
- `rear_grab_bar_toilet_centerline_span`
- `lavatory_knee_clearance_min`

Do not report vertical requirements such as seat height, mounting height, mirror height, signage height, or pipe protection if the task scope excludes them.

Use combined rule names for range checks. For example, if the toilet centerline is outside the allowed range, report `toilet_centerline_from_side_wall_range`; do not invent separate `*_min` or `*_max` violation names unless the rules file explicitly asks for them.

Use the element id that matches the failed requirement's scope:

- For toilet centerline failures, use the toilet id, such as `WC1`.
- For room-level turning-circle fit failures, use the room id, such as `bathroom_1`, because the failure is about whether usable floor area can contain the full circle.
- For grab-bar length failures, report them only after classifying the actual side-wall and rear-wall grab bars. Do not report grab-bar failures when the classified bars meet the minimum lengths.
- For lavatory knee/toe clearance, report a violation only when the lavatory lacks the indicated plan-view knee/toe clearance or the stated width/depth is below the rule minimum. Do not infer a before-repair violation from unrelated fixture graphics when the extracted lavatory metadata satisfies the rule.

## Repair Principles

- Preserve existing walls and fixtures whenever a local move or small expansion solves the problem.
- Prefer changing door swing/opening representation over redesigning the whole room.
- Keep protected fixtures such as tubs in place unless the rules make that impossible.
- If the toilet moves, update or validate the grab-bar segments against the repaired toilet position.
- Make every repair traceable to a violation or to preserving a valid clearance.
