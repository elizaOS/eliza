# payment-app-charge

- **route:** `payment/app-charge/:appId/:chargeId`
- **path:** `/payment/app-charge/app-smoke-1/charge-smoke-1`

## desktop

- **verdict:** good
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** none
- **readable content chars:** 91
- **screenshot quality issues:** none

## mobile

- **verdict:** good
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** none
- **readable content chars:** 91
- **screenshot quality issues:** none

## Hand review

Dark charge card renders: app identity, $5.00, 'Ready - expires …', Card/Crypto method tiles, provider footer. Runs 1-2 crashed with RangeError: Invalid time value — the page Intl-formats charge.expiresAt with no guard; surfaced once the stub omitted the field. Stub now carries the full AppChargeDetails shape. Page-side robustness note for #10725: formatDate should degrade on invalid dates instead of throwing.

_Reviewed by hand from the committed desktop + mobile screenshots (rebased 69/69 green). Machine scan (report.json): no blue, no orange-hover violations, no console errors on this page unless noted above._
