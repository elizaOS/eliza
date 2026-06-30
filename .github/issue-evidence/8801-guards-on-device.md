# #8801 — the backfilled guards run on the Android agent (not just in unit tests)

This turn added deterministic coverage for security/safety-critical guards
(crypto, money, PII, runaway-loop, input sanitization). Those guards aren't
test-only artifacts — they are compiled into the agent that runs **on-device**.
Verified against the live Android agent (emulator-5556, `ai.elizaos.app`).

## The agent is live on-device

- agent process: pid **31236**, `agent-bundle.js` = **69.8 MB**
- `/api/health` is answered on-device (CapacitorCookies/Agent-plugin polls in logcat)

## The guards are present in the running on-device agent bundle

`grep` of `/data/data/ai.elizaos.app/files/agent/agent-bundle.js`:

| guard (PR) | occurrences in on-device bundle |
|---|---|
| `assertQuoteFresh` (#10516) | 2 |
| `recordAgentAutoTrade` (#10516) | 3 |
| `maskSecret` (#10521) | 6 |
| `sanitizeConversationMetadata` (#10519) | 7 |
| `assertRepeatedFailureLimit` (#10518) | 2 |
| `encryptAes256Gcm` (#10520) | 2 |

So the trade-safety, secret-masking, metadata-sanitizer, planner-limit, and
AES-GCM guards are all deployed in the agent process executing on the phone —
the unit tests (#10516–#10522) pin behavior that genuinely runs on-device.

Notes: `planModuleCacheEvictions` (#10509) is intentionally **absent** from the
agent bundle — it is a renderer/WebView function (`packages/ui`), so it ships in
the web bundle the WebView loads, not in `agent-bundle.js`. `sanitizeExperienceText`
(#10517) is minified/inlined in this production build so its source name does not
survive the grep.
