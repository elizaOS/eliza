# #10710 — fix the aesthetic-audit blue false-positive that marked every view `needs-work`

## Problem (found by running `audit:app` on this Linux host)
The all-views aesthetic audit (the per-view QA gate: ~50 views × 4 viewports)
marked **236 of 348** view/viewport combos `needs-work` — and **every single one**
was driven by the *same* colour, `rgba(10, 10, 12, 0.5)`, classified as `"blue"`
(a no-blue brand violation). That colour is the continuous-chat overlay's dark
scrim, painted on **every** view, so one mis-classification dragged the whole
app to `needs-work` and made the gate untrustworthy.

`rgba(10,10,12,0.5)` is perceptually **pure black**: `b` is only 2/255 above
`r`/`g`. But at that low luminance the saturation *ratio* (`chroma/max = 2/12 =
0.17`) slips past the `saturation < 0.15` achromatic gate, and the hue lands at
240° → the classifier calls it `blue`.

## Fix
`packages/app/test/ui-smoke/aesthetic-audit-rules.ts` `bucket()` — add an
**absolute-chroma floor** to the achromatic gate:
`if (saturation < 0.15 || chroma < 12) return lum < 0.08 ? "black" : "neutral";`
A near-achromatic dark scrim (chroma 2) is now correctly `black`; a genuinely
saturated dark navy (`rgb(10,10,40)`, chroma 30) still falls through to the blue
band, so real brand violations still surface.

## Result (re-ran the full `audit:app` before/after)
| | needs-work | needs-eyeball | good | broken | still flagged blue |
|---|---|---|---|---|---|
| **before** | **236** | 0 | 112 | 0 | 236 |
| **after** | **0** | 212 | 136 | 0 | **0** |

`before-verdict-summary.json` / `after-verdict-summary.json` are the machine
summaries from the two full audit runs (349 tests each, ~20 min). No view is
actually a blue violation; the remaining `needs-eyeball` are the *soft*,
non-blocking radius/density signals (e.g. the overlay's 32px sheet radius) — the
gate now reports the true state and passes with **zero broken and zero
needs-work** for the default set.

## Tests
`packages/app/test/audit/aesthetic-audit-rules.test.ts` — **30 passed** (added a
regression case: `rgba(10,10,12,0.5)` → `black`, `rgb(12,12,14)` → `black`,
`rgb(240,241,244)` → `neutral`; the existing navy `rgb(10,10,40)` → `blue` guard
still holds).

Real-LLM trajectory / backend logs — N/A (test-infra correctness fix).
