# plugin-cockpit-gui (mobile-landscape)

- **path:** `/cockpit`
- **verdict:** good
- **console errors:** 0
- **blue colors (banned):** none
- **border-radius violations (off-token):** none
- **orange↔black hover violations:** none
- **hover probe failures:** none
- **density probe failures:** none
- **floating chat overlay present:** yes
- **floating chat overlay clearance:** clear
- **readable content chars:** 486
- **border/divider density:** 18.2282 (6 edges / 1M px)
- **text density:** 5.0735 chars / 10K px
- **whitespace ratio:** 0.8338
- **minimalism budget:** n/a
- **minimalism ratchet (#9950):** pass
- **screenshot quality issues:** none

## Notes

**verdict: good (loop-1 needs-work RESOLVED by #14198).** Loop 1 flagged this
mobile-landscape view for ContinuousChatOverlay clearance (overlay overlapped
bottom-row view controls). #14198's short-landscape compact-landing shrinks the
resting composer to a bottom-corner affordance; overlayClear is now 0. This view
has no bottom-anchored action row reaching into the corner, so it clears cleanly.
Uniform ViewHeader, orange accent only, no blue.

_Reviewed in #13598 audit-sweep loop 2 (post-knowledge-hub verification)._
