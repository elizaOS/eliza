# builtin-chat (desktop-landscape)

- **path:** `/chat`
- **verdict:** good
- **console errors:** 0
- **blue colors (banned):** none
- **border-radius violations (off-token):** none
- **orange↔black hover violations:** none
- **hover probe failures:** none
- **density probe failures:** none
- **floating chat overlay present:** yes
- **floating chat overlay clearance:** clear
- **readable content chars:** 510
- **border/divider density:** 9.2593 (12 edges / 1M px)
- **text density:** 1.2269 chars / 10K px
- **whitespace ratio:** 0.961
- **minimalism budget:** pass
- **minimalism ratchet (#9950):** pass
- **screenshot quality issues:** none

## Notes

Home/chat surface renders the single infinite thread with the per-view proactive greeting (#13587: clock/date/'Good afternoon') and the home quick-reply chips (What's left today? / What can you do? / Summarize my day / Dismiss). These are the agent-proactive greeting's quick replies (`chat-suggestions`), NOT the page-view suggestion chips removed in #14098 — those were removed and are absent. Uniform floating 'Ask Eliza' composer; overlay present; the warm `--launch-bg` bottom floor (continuous-chat-bottom-floor, #14072) paints the reclaimed home-gesture strip. No blue, orange accent only. GOOD.

_Reviewed in #13598 audit-sweep loop 1 (post-merge integration baseline)._
