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
- **readable content chars:** 284
- **border/divider density:** 6.9444 (9 edges / 1M px)
- **text density:** 1.7515 chars / 10K px
- **whitespace ratio:** 0.7383
- **minimalism budget:** pass
- **minimalism ratchet (#9950):** pass
- **screenshot quality issues:** none

## Notes

#14074 landed: uniform ViewHeader ('Browser', icon-only back) sits ABOVE the browser toolbar (URL bar / Go / sidebar toggle / +/refresh/×) — no double header. Section-nav sidebar (User/Agent/App Tabs). Designed empty state ('No browser tabs yet') keeps the functional 'Open a website' CTA (explicitly retained by #14098) + 'Install Agent Browser Bridge'. Orange accent only, no blue. Desktop/ipad/mobile-portrait GOOD.

_Reviewed in #13598 audit-sweep loop 1 (post-merge integration baseline)._
