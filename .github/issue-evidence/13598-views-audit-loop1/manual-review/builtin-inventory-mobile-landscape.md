# builtin-inventory (mobile-landscape)

- **path:** `/wallet`
- **verdict:** needs-work
- **console errors:** 0
- **blue colors (banned):** none
- **border-radius violations (off-token):** none
- **orange↔black hover violations:** none
- **hover probe failures:** none
- **density probe failures:** none
- **floating chat overlay present:** yes
- **floating chat overlay clearance:** overlay overlaps "Tokens" (1288px²); overlay overlaps "DeFi" (1326px²); overlay overlaps "NFTs" (1288px²)
- **readable content chars:** 468
- **border/divider density:** 3.038 (1 edges / 1M px)
- **text density:** 3.2507 chars / 10K px
- **whitespace ratio:** 0.4603
- **minimalism budget:** pass
- **minimalism ratchet (#9950):** pass
- **screenshot quality issues:** none

## Notes

needs-work: continuous chat overlay overlaps the Tokens/DeFi/NFTs section tabs in landscape (shared-overlay geometry, ~1.3K px² each). Same systemic mobile-landscape overlay-clearance issue as browser/wallet/documents. Pre-existing, not a merge regression.

_Reviewed in #13598 audit-sweep loop 1 (post-merge integration baseline)._
