# builtin-browser (mobile-landscape)

- **path:** `/browser`
- **verdict:** needs-work
- **console errors:** 0
- **blue colors (banned):** none
- **border-radius violations (off-token):** none
- **orange↔black hover violations:** none
- **hover probe failures:** none
- **density probe failures:** none
- **floating chat overlay present:** yes
- **floating chat overlay clearance:** overlay overlaps "Open Browser Bridge Folder" (12544px²); overlay overlaps "Open Chrome extensions" (12263px²); overlay overlaps "Refresh Browser Bridge" (9951px²)
- **readable content chars:** 284
- **border/divider density:** 27.3423 (9 edges / 1M px)
- **text density:** 6.8963 chars / 10K px
- **whitespace ratio:** 0.4329
- **minimalism budget:** pass
- **minimalism ratchet (#9950):** pass
- **screenshot quality issues:** none

## Notes

needs-work: the floating chat overlay overlaps the empty-state controls (Open Browser Bridge Folder / Open Chrome extensions / Refresh Browser Bridge) in the 844x390 landscape viewport (overlay clearance issue, ~10-12K px² each). This is the shared ContinuousChatOverlay's mobile-landscape geometry, NOT a #14074 regression — the same overlap hits inventory/wallet/documents/cockpit in landscape. Pre-existing; tracked for the overlay-clearance follow-up, not hot-fixed in loop 1.

_Reviewed in #13598 audit-sweep loop 1 (post-merge integration baseline)._
