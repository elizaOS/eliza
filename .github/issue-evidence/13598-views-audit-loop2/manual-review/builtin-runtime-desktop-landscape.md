# builtin-runtime (desktop-landscape)

- **path:** `/apps/runtime`
- **verdict:** needs-eyeball
- **console errors:** 0
- **blue colors (banned):** none
- **border-radius violations (off-token):** none
- **orange↔black hover violations:** none
- **hover probe failures:** none
- **density probe failures:** none
- **floating chat overlay present:** yes
- **floating chat overlay clearance:** clear
- **readable content chars:** 887
- **border/divider density:** 53.2407 (69 edges / 1M px)
- **text density:** 6.196 chars / 10K px
- **whitespace ratio:** 0.7173
- **minimalism budget:** n/a
- **minimalism ratchet (#9950):** pass
- **screenshot quality issues:** none

## Notes

**verdict: needs-eyeball (soft off-token border-radius signal only,
non-blocking).** Same soft radius signal as loop 1; no blue, no console errors,
overlay clear, uniform ViewHeader. Records the signal without blocking the
baseline.

_Reviewed in #13598 audit-sweep loop 2 (post-knowledge-hub verification)._
