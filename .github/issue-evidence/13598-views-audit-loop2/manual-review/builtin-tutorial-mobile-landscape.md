# builtin-tutorial (mobile-landscape)

- **path:** `/tutorial`
- **verdict:** needs-work
- **console errors:** 0
- **blue colors (banned):** none
- **border-radius violations (off-token):** none
- **orange↔black hover violations:** none
- **hover probe failures:** "Reopen the tour" hover probe failed: locator.hover: Timeout 1000ms exceeded.
- **density probe failures:** none
- **floating chat overlay present:** yes
- **floating chat overlay clearance:** overlay overlaps "Reopen the tour" (2547px²)
- **readable content chars:** 427
- **border/divider density:** 0 (0 edges / 1M px)
- **text density:** 3.6153 chars / 10K px
- **whitespace ratio:** 0.9101
- **minimalism budget:** n/a
- **minimalism ratchet (#9950):** pass
- **screenshot quality issues:** none

## Notes

**verdict: needs-work (BY-DESIGN false positive — hand verdict: good).**

The /tutorial route is a thin launcher for the chat-native tour
(TutorialView.tsx: "The tour runs in the chat — it's open below."). It
DELIBERATELY opens the ContinuousChatOverlay in the half-detent to run the tour
(the "Hi — I'm Eliza. Want a quick tour?" thread with Next / Stop tutorial
buttons is the view's primary content). The clearance heuristic reports the
open overlay covering the "Reopen the tour" fallback button (2547px2) as an
overlap, but that button is only relevant when the tour is CLOSED; with the tour
open, the overlay showing tour content over it is the intended interaction, not
a blocked tap target. This is NEW vs loop 1 only because #14300 (chat history)
changed the overlay so the auto-opened tour now renders expanded at capture
time. No source defect. Uniform "Tutorial"/spark header, designed empty state,
orange accent only, no blue.

_Reviewed in #13598 audit-sweep loop 2 (post-knowledge-hub verification)._
