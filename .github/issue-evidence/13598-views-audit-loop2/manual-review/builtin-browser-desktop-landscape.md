# builtin-browser (desktop-landscape)

- **path:** `/browser`
- **verdict:** good
- **console errors:** 0
- **blue colors (banned):** none
- **border-radius violations (off-token):** none
- **orange↔black hover violations:** none
- **hover probe failures:** none
- **density probe failures:** none
- **floating chat overlay present:** yes
- **floating chat overlay clearance:** clear
- **readable content chars:** 224
- **border/divider density:** 6.1728 (8 edges / 1M px)
- **text density:** 1.3194 chars / 10K px
- **whitespace ratio:** 0.8811
- **minimalism budget:** pass
- **minimalism ratchet (#9950):** pass
- **screenshot quality issues:** none

## Notes

**verdict: good.** Browser folded tabs (#14149) verified at desktop. Uniform
"Browser" ViewHeader ABOVE the toolbar (no double header). Folded-tab switcher:
"No tab 0" compact fold control (old User/Agent/App Tabs sidebar gone) + new-tab
/ refresh / close + URL bar + Go. Designed empty state (globe icon + "No browser
tabs yet" + "Open a website" orange CTA + "Install Agent Browser Bridge" + bridge
action row). Overlay clear at desktop (compact-landing is landscape-phone only).
Orange accent only, no blue.

_Reviewed in #13598 audit-sweep loop 2 (post-knowledge-hub verification)._
