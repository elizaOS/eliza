# #11632 LifeOps Live-Validation Status

Generated: 2026-07-03T20:43:37.390Z

Verdict: **not closeable**. This is a read-only status artifact; live OAuth,
account, sandbox, and physical-device rows still need operator evidence.

| Surface | Status | Required | Present env names | Missing |
|---|---|---|---|---|
| Live model provider | blocked | one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, CEREBRAS_API_KEY, ELIZA_LIVE_TEST_LOCAL_LLAMA_CPP_BASE_URL | none | OPENAI_API_KEY, ANTHROPIC_API_KEY, CEREBRAS_API_KEY, ELIZA_LIVE_TEST_LOCAL_LLAMA_CPP_BASE_URL |
| Google Calendar / Gmail | blocked | GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI | none | GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI |
| Discord | blocked | one of: DISCORD_API_TOKEN, DISCORD_BOT_TOKEN | none | DISCORD_API_TOKEN, DISCORD_BOT_TOKEN |
| Telegram | blocked | TELEGRAM_BOT_TOKEN | none | TELEGRAM_BOT_TOKEN |
| Slack | blocked | SLACK_BOT_TOKEN, SLACK_APP_TOKEN | none | SLACK_BOT_TOKEN, SLACK_APP_TOKEN |
| Signal | blocked | SIGNAL_ACCOUNT_NUMBER | none | SIGNAL_ACCOUNT_NUMBER, SIGNAL_HTTP_URL, SIGNAL_CLI_PATH |
| WhatsApp | blocked | ELIZA_WHATSAPP_ACCESS_TOKEN, ELIZA_WHATSAPP_PHONE_NUMBER_ID | none | ELIZA_WHATSAPP_ACCESS_TOKEN, ELIZA_WHATSAPP_PHONE_NUMBER_ID |
| X | blocked | one of: X_API_KEY, TWITTER_API_KEY, TWITTER_BEARER_TOKEN | none | X_API_KEY, TWITTER_API_KEY, TWITTER_BEARER_TOKEN |
| Phone / SMS / Voice | blocked | TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN | none | TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN |
| Health | blocked | one of: ELIZA_HEALTHKIT_CLI_PATH, ELIZA_GOOGLE_FIT_ACCESS_TOKEN, FITBIT_ACCESS_TOKEN, OURA_ACCESS_TOKEN, STRAVA_ACCESS_TOKEN, WITHINGS_ACCESS_TOKEN | none | ELIZA_HEALTHKIT_CLI_PATH, ELIZA_GOOGLE_FIT_ACCESS_TOKEN, FITBIT_ACCESS_TOKEN, OURA_ACCESS_TOKEN, STRAVA_ACCESS_TOKEN, WITHINGS_ACCESS_TOKEN |
| Finances | blocked | one of: LIFEOPS_FINANCE_CSV_FIXTURE, PLAID_CLIENT_ID, PLAID_SECRET, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET | none | LIFEOPS_FINANCE_CSV_FIXTURE, PLAID_CLIENT_ID, PLAID_SECRET, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET |
| iOS / macOS native permissions | blocked | one of: ELIZA_IMESSAGE_BACKEND, ELIZA_NATIVE_PERMISSIONS_DYLIB, ELIZA_HEALTHKIT_CLI_PATH | none | ELIZA_IMESSAGE_BACKEND, ELIZA_NATIVE_PERMISSIONS_DYLIB, ELIZA_HEALTHKIT_CLI_PATH |
| Android native permissions | blocked | one of: ANDROID_SERIAL | ANDROID_HOME | ANDROID_SERIAL |

## Device Tooling

| Tool | Available | Summary |
|---|---:|---|
| adb | yes | List of devices attached<br>27051JEGR10034         device usb:5-2 product:bluejay model:Pixel_6a device:bluejay transport_id:2 |
| xcrun | no | n/a |
| devicectl | no | n/a |

## Existing Evidence

- present: `.github/issue-evidence/8833-lifeops-live-validation/README.md`
- present: `.github/issue-evidence/8833-lifeops-live-validation/2026-07-02-keyless-run/README.md`
- present: `.github/issue-evidence/8833-lifeops-live-validation/2026-07-02-keyless-run/owner-agent-permission-matrix.txt`
- present: `.github/issue-evidence/8833-lifeops-live-validation/2026-07-02-keyless-run/connector-keyless-suites.txt`
- missing: `.github/issue-evidence/8833-lifeops-live-validation/11632-status/owner-agent-permission-matrix.txt`
- missing: `.github/issue-evidence/8833-lifeops-live-validation/11632-status/plugin-google-live.txt`
- missing: `.github/issue-evidence/8833-lifeops-live-validation/11632-status/plugin-x-live.txt`
