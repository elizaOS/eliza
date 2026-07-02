# app-auth-authorize

- **route:** `app-auth/authorize`
- **path:** `/app-auth/authorize?app_id=app-smoke-1&redirect_uri=https%3A%2F%2Fexample.com%2Fcb`

## desktop

- **verdict:** good
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** none
- **readable content chars:** 132
- **screenshot quality issues:** none

## mobile

- **verdict:** good
- **console errors:** none
- **blue colors (banned):** none
- **orange hover violations:** none
- **hover probe failures:** none
- **readable content chars:** 132
- **screenshot quality issues:** none

## Hand review

Clean signed-in app consent state for the deterministic Smoke App fixture. The Playwright test-auth adapter avoids the previous Steward-provider harness crash while still exercising the real public app validation call and consent UI.

_Reviewed by hand from the committed desktop + mobile screenshots (rebased 69/69 green). Machine scan (report.json): no blue, no orange-hover violations, no console errors on this page._
