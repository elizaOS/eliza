# builtin-apps (ipad-portrait)

- **path:** `/apps`
- **verdict:** good
- **console errors:** 0
- **blue colors (banned):** rgba(10, 10, 12, 0.5)
- **border-radius violations (off-token):** 32px
- **orange↔black hover violations:** none
- **floating chat overlay present:** yes
- **floating chat overlay clearance:** clear
- **readable content chars:** 606
- **border/divider density:** 107.4824 (104 edges / 1M px)
- **text density:** 2.8938 chars / 10K px
- **whitespace ratio:** 0.7344
- **minimalism budget:** pass
- **screenshot quality issues:** none

## Notes

Reviewed manually for #9144 after removing the default favorites row. Chat and
Settings render as normal first-row launcher tiles, the old top dock/favorites
strip is absent, labels fit, and the composer overlay has clear bottom
clearance.
