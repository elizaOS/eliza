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
- **floating chat overlay clearance:** overlay overlaps "Refresh Browser Bridge" (4888px²)
- **readable content chars:** 224
- **border/divider density:** 24.3043 (8 edges / 1M px)
- **text density:** 5.195 chars / 10K px
- **whitespace ratio:** 0.6507
- **minimalism budget:** pass
- **minimalism ratchet (#9950):** pass
- **screenshot quality issues:** none

## Notes

**verdict: needs-work** (residual overlay-clearance graze — improved but not eliminated).

Folded-tab switcher (#14149) renders correctly: the old User/Agent/App Tabs
sidebar is gone, replaced by the compact "No tab 0" fold control + new-tab /
refresh / close controls above the URL bar. Uniform "Browser" ViewHeader sits
ABOVE the toolbar (no double header). Designed empty state ("No browser tabs
yet" + "Open a website" + "Install Agent Browser Bridge"). Orange accent only,
no blue.

The ContinuousChatOverlay compact-landing fix (#14198) IS active here — the
resting composer shrank to a bottom-corner affordance instead of the loop-1
full-width band. That cut the overlaps from **3 (loop 1) -> 1 (loop 2)**. The
residual: the browser's bridge-action row is a full-width `sm:grid-cols-3` grid
whose rightmost cell ("Refresh connection" / "Refresh Browser Bridge") lands
under the bottom-right corner affordance (4888px2 overlap). The other five
loop-1 overlay pages (inventory, documents-gui, lifeops-gui, wallet-gui,
cockpit-gui) have no bottom-anchored control row, so the corner affordance
clears them — they are now `good`. Browser is the one page whose fallback
bridge-connectivity row reaches into the corner. Filed as a precise follow-up
issue rather than fixed inline (a cross-cutting bottom-clearance change risks
regressing the five pages #14198 fixed).

_Reviewed in #13598 audit-sweep loop 2 (post-knowledge-hub verification)._
