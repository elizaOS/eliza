# Unitree R1 Bodykit Visual Review

Date: 2026-05-23

## Verdict

needs-work

## Reviewed Artifacts

- `bodykit-contact-sheet.png`
- `bodykit_front.png`
- `bodykit_rear.png`
- `bodykit_left.png`
- `bodykit_right.png`
- `bodykit_head.png`
- `bodykit_head_three_quarter.png`
- `bodykit_upper_three_quarter.png`
- `bodykit_front_concept_overlay.png`
- `bodykit_left_concept_overlay.png`
- `bodykit_right_concept_overlay.png`
- `bodykit_rear_concept_overlay.png`
- `bodykit_front_reference_scale_overlay.png`
- `bodykit_left_reference_scale_overlay.png`
- `bodykit_right_reference_scale_overlay.png`
- `unitree-r1-bodykit-orbit.mp4`
- `blender-bodykit-parts.png`
- `visual-concept-orange-android.png`
- `reference-validation.json`
- `eliza-face-donor.png`

## Assessment

The generated MuJoCo bodykit is valid as an EVT simulator and
tooling-pipeline fixture, but it is not aesthetically final yet. The primitive
ellipsoid face has been replaced by an open human-generator donor faceplate, and
the black eye blobs have been replaced with smaller surface inserts. The major
torso, pelvis, shoulder, arm, thigh, and shin shells now use inflated envelopes
derived from the Unitree R1 OEM STL meshes instead of freehand
ellipsoids/capsules.

The aesthetic direction is closer to the reference because the body panels now
follow the R1 mechanical forms, and the new 3/4 head/upper-body renders make
the face seating and neck integration easier to review. The faceplate is still a
source mesh rather than a surfaced hard-plastic production mask. The next design
pass should improve face surfacing, add a proper head carrier boundary, and add
production panel splits/mounts rather than reverting to freehand primitive
forms.

The supplied Eliza front PNG and single-mesh GLB are now copied into
`cad/source-assets/concept/` and validated in `reference-validation.json`. The
GLB is treated as non-production design reference only; its measured height is
1.89834 m and the current reference report records a 0.64793 scale factor to
the R1 height envelope. Front/side/rear review images now place the concept
behind the MuJoCo render so the orange-black hard-plastic proportions can be
judged directly against the bodykit.

## Manual Notes

- Front/rear/side MuJoCo renders show the shell mounted to the R1 without hair
  or eyewear.
- Head close-up shows the human donor faceplate with eye/lip detail, but it
  still needs sculpt cleanup, smoother facial surfacing, and real hard-shell
  boundaries.
- 3/4 head and upper-body renders show the donor face seated on the R1 neck
  envelope without hair or eyewear. The proportions are usable for EVT review,
  but the bald head carrier still needs production styling.
- Front/rear/side renders show OEM-derived shell envelopes on the torso,
  pelvis, arms, thighs, and shins, plus the updated foot/ankle pass: tapered
  orange boot uppers, separate rounded toe armor, black outsole bands, and rear
  black heel underbody blocks. The leg pass now uses slimmer black thigh/shin
  underbody hulls with separate orange front and side armor plates, plus
  narrowed black knee relief panels, instead of single inflated orange leg
  blobs.
- Region review now covers 69 generated bodykit parts across feet/ankles, legs,
  hips/torso/chest/back, arms, and neck/head/face with no unclassified parts.
- Panel-gap validation is back to `pass` after the foot/ankle, leg, and
  torso/hips clearance passes.
  The separated leg plates clear the sampled gap gate; the smallest sampled
  overall gap is currently a seated face-detail interface at 0.415 mm, above
  its 0.1 mm seated-detail gate. The smallest articulated gap is an
  upper-arm/forearm interface at 1.01 mm, above its 1.0 mm gate. Production
  clearance now passes the current operating gate in
  `fit-validation.json`. Clearance sampling is deterministic and separates
  adjacent kinematic interfaces from true non-adjacent clearance. Static
  non-adjacent clearance now clears the 8 mm target at 72.595 mm, and the
  operating sweep clears the 18 mm target at 23.835 mm. The wider mechanical
  stress sweep is still below 18 mm at 1.062 mm in
  `right_shoulder_pitch_joint_low__right_elbow_joint_low`;
  `mechanical-stress-blockers.json` groups the remaining stress-only blockers
  by region and part for the next geometry pass.
- Blender render verifies that the assembled GLB can be imported and rendered
  outside MuJoCo.
- Concept overlay renders now exist for front, side, rear, operating blocker,
  and mechanical blocker review. The next surfacing pass should use those views
  to pull the current EVT shells toward the supplied orange-black reference,
  especially the face/eye/lip readability, chest plate, pelvis center plate,
  and heeled foot silhouette. The seated-detail face inserts make the eyes
  readable again while preserving face-alignment and panel-gap passes. The
  lip insert is wider and no longer the current worst stress blocker, but
  the face still needs production surfacing around the eyes and mouth. The
  latest secondary clearance pass also slimmed pelvis, thigh, shin, forearm,
  and wrist geometry while keeping panel gaps passing; the narrowed thigh/side-plate
  pass removed the right-thigh cross-knee blocker from the current stress list.
  The knee/toe cleanup converted raised knee detail inserts to markings,
  improving the worst non-head stress row to `left_shin_front_armor` at
  6.886 mm, and removed the left toe armor from the current stress-blocker list. The
  wrist/forearm pass removed the raised wrist-index accents from geometry,
  treating them as painted or molded-color markings instead; the remaining
  arm stress rows are now `left_forearm_outer_blade` at 15.607 mm and
  `right_forearm_outer_blade` at 16.378 mm. The right boot outsole pass removed the right
  sole blocker and shifted the current foot stress row to the left top shell
  at 14.535 mm while preserving the rigid foot panel gap. The abdomen inset
  and pelvis-center trim removed abdomen/pelvis center armor from the current
  stress-blocker list while preserving panel gaps. The latest visual-coverage
  pass keeps the bodykit at 69 generated parts after converting tiny wrist,
  abdomen side-cut, and knee raised details to markings, with longer shallow
  chest side skins, an under-bust black inset, rear back cut lines, rear glute
  armor skins, and a modestly restored right thigh front armor plate; these improve the orange/black
  layered read while keeping production fit and panel gaps passing. The former
  OEM-inflated major torso, pelvis, neck, shoulder, upper-arm, forearm, thigh,
  and shin hulls are now explicit `section_loft` CAD definitions and export as
  STEP; the donor face is now a parametric fixed-grid loft and exports as STEP. Shin armor
  has moved closer to the concept direction but still needs production
  surfacing and real split-line CAD. The face/wrist stress rows are
  now also captured in `head-keepout-policy.json` so later CAD passes can protect
  the donor-derived face with pose limits instead of flattening it further. The
  face alignment report now separates 2D proportion alignment from face-volume
  quality: proportions pass, and `face_shell_depth_check` now passes at
  15.380 mm against a 12.0 mm minimum after replacing the donor mesh with a
  parametric grid loft without breaking production fit or panel gaps.
  `face_production_surfacing` now records `parametric-step-pass` for the
  donor-derived face shell.

## Required Before Tooling Release

- Replace preliminary EVT STEP envelopes with production surfaced solids.
- Convert preliminary loft envelopes into production surfaced CAD.
- Add real split-line, boss, rib, and insert geometry.
- Validate against final Unitree R1 mechanical CAD or scan.
- Repeat visual review after production surfacing.
