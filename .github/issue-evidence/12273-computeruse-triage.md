# #12273 triage inventory — plugins/plugin-computeruse (full src sweep)

Chunk W1-I of the #12273 fallback-slop sweep; extends PR #12885's precision slice.
Every `catch` handler and promise `.catch` in non-test `src/**/*.ts` was re-derived
from source at this branch's HEAD and triaged against the binding J1–J7 rubric.
Verdicts: `J<N>` = kept, annotated `// error-policy:J<N> <reason>` at the site;
`rethrow` = handler propagates (adds context or classifies then throws) — nothing
swallowed, outside the sweep's suspect classes; `route-J1` = sandbox/compat route
boundary translating failures into explicit 4xx/5xx JSON payloads — the issue's
sanctioned directory-level J1 documentation for `src/routes/**`; `EXEMPT` =
grep hit inside an embedded PowerShell/JXA script string literal, not a TS handler.

Fixes landed in this chunk (beyond annotations): a11y per-window failure counting +
once-per-scan `runtime.reportError("Computeruse.a11yScan", …, { failedWindows,
totalWindows })` (exemplar 2); `fileExists`/`directoryExists` errno narrowing (EACCES
no longer reads as "absent"); scene/computer-state providers + vision-context now
report pipeline failures; process/window enumeration failures warn instead of reading
as an empty machine; approval-mode load/persist failures surfaced; COMPUTER_USE_AGENT
returns `result.error` on non-finish; progress-callback failures reportError'd (J7).

| site | verdict |
|---|---|
| `src/actions/clipboard.ts:181` | J1 (annotated at site) |
| `src/actions/progress.ts:132` | J5 (annotated at site) |
| `src/actions/use-computer-agent.ts:285` | J1 (annotated at site) |
| `src/actions/use-computer-agent.ts:303` | J1 (annotated at site) |
| `src/actions/use-computer-agent.ts:393` | J7 (annotated at site) |
| `src/actions/use-computer-agent.ts:433` | J7 (annotated at site) |
| `src/actions/use-computer-agent.ts:461` | J4 (annotated at site) |
| `src/actor/actor.ts:223` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/actor/aosp-input-actor.ts:139` | J1 (annotated at site) |
| `src/actor/aosp-input-actor.ts:172` | J1 (annotated at site) |
| `src/actor/aosp-input-actor.ts:202` | J1 (annotated at site) |
| `src/actor/brain.ts:343` | J3 (annotated at site) |
| `src/actor/brain.ts:373` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/actor/brain.ts:566` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/actor/cascade.ts:394` | J4 (annotated at site) |
| `src/actor/cascade.ts:432` | J4 (annotated at site) |
| `src/actor/computer-interface.ts:202` | J4 (annotated at site) |
| `src/actor/dispatch.ts:72` | J1 (annotated at site) |
| `src/actor/dispatch.ts:86` | J1 (annotated at site) |
| `src/actor/dispatch.ts:100` | J1 (annotated at site) |
| `src/actor/dispatch.ts:114` | J1 (annotated at site) |
| `src/actor/dispatch.ts:147` | J1 (annotated at site) |
| `src/actor/dispatch.ts:176` | J1 (annotated at site) |
| `src/approval-manager.ts:197` | J3 (annotated at site) |
| `src/approval-manager.ts:220` | J4 (annotated at site) |
| `src/mcp/server.ts:66` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/mobile/android-scene.ts:52` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/osworld/adapter.ts:70` | J4 (annotated at site) |
| `src/platform/a11y.ts:67` | J4 (annotated at site) |
| `src/platform/a11y.ts:155` | J4 (annotated at site) |
| `src/platform/a11y.ts:207` | J4 (annotated at site) |
| `src/platform/a11y.ts:257` | J4 (annotated at site) |
| `src/platform/browser.ts:36` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/platform/browser.ts:137` | J3 (annotated at site) |
| `src/platform/browser.ts:161` | J3 (annotated at site) |
| `src/platform/browser.ts:239` | J4 (annotated at site) |
| `src/platform/browser.ts:260` | J6 (annotated at site) |
| `src/platform/browser.ts:274` | J6 (annotated at site) |
| `src/platform/browser.ts:393` | J1 (annotated at site) |
| `src/platform/browser.ts:507` | J1 (annotated at site) |
| `src/platform/capture.ts:102` | J6 (annotated at site) |
| `src/platform/capture.ts:113` | J6 (annotated at site) |
| `src/platform/capture.ts:152` | J6 (annotated at site) |
| `src/platform/capture.ts:178` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/platform/capture.ts:308` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/platform/capture.ts:381` | J4 (annotated at site) |
| `src/platform/clipboard.ts:118` | J4 (annotated at site) |
| `src/platform/clipboard.ts:159` | J4 (annotated at site) |
| `src/platform/desktop.ts:906` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/platform/desktop.ts:994` | J4 (annotated at site) |
| `src/platform/displays.ts:238` | J4 (annotated at site) |
| `src/platform/displays.ts:255` | J4 (annotated at site) |
| `src/platform/displays.ts:268` | J4 (annotated at site) |
| `src/platform/displays.ts:290` | J3 (annotated at site) |
| `src/platform/displays.ts:329` | J3 (annotated at site) |
| `src/platform/displays.ts:381` | J3 (annotated at site) |
| `src/platform/displays.ts:434` | J4 (annotated at site) |
| `src/platform/displays.ts:468` | J4 (annotated at site) |
| `src/platform/displays.ts:499` | J3 (annotated at site) |
| `src/platform/displays.ts:566` | J3 (annotated at site) |
| `src/platform/displays.ts:625` | J4 (annotated at site) |
| `src/platform/displays.ts:650` | J4 (annotated at site) |
| `src/platform/driver.ts:252` | J4 (annotated at site) |
| `src/platform/file-ops.ts:27` | J1 (annotated at site) |
| `src/platform/file-ops.ts:54` | J1 (annotated at site) |
| `src/platform/file-ops.ts:92` | J1 (annotated at site) |
| `src/platform/file-ops.ts:119` | J1 (annotated at site) |
| `src/platform/file-ops.ts:144` | J1 (annotated at site) |
| `src/platform/file-ops.ts:175` | J3 (annotated at site) |
| `src/platform/file-ops.ts:219` | J1 (annotated at site) |
| `src/platform/file-ops.ts:244` | J1 (annotated at site) |
| `src/platform/file-ops.ts:291` | J1 (annotated at site) |
| `src/platform/file-ops.ts:320` | J1 (annotated at site) |
| `src/platform/file-ops.ts:344` | J1 (annotated at site) |
| `src/platform/file-ops.ts:369` | J3 (annotated at site) |
| `src/platform/file-ops.ts:407` | J1 (annotated at site) |
| `src/platform/helpers.ts:32` | J3 (annotated at site) |
| `src/platform/launch.ts:93` | J1 (annotated at site) |
| `src/platform/nut-driver.ts:81` | J3 (annotated at site) |
| `src/platform/nut-driver.ts:366` | J4 (annotated at site) |
| `src/platform/nut-driver.ts:551` | J6 (annotated at site) |
| `src/platform/permissions.ts:215` | EXEMPT — embedded PS one-liner; the catch emits the explicit 'Unknown' marker, which the TS side maps to probed:false (not a fabricated allow/deny). |
| `src/platform/permissions.ts:242` | J3 (annotated at site) |
| `src/platform/permissions.ts:252` | J3 (annotated at site) |
| `src/platform/permissions.ts:262` | J3 (annotated at site) |
| `src/platform/process-list.ts:49` | J4 (annotated at site) |
| `src/platform/process-list.ts:69` | J3 (annotated at site) |
| `src/platform/process-list.ts:89` | J4 (annotated at site) |
| `src/platform/process-list.ts:100` | J4 (annotated at site) |
| `src/platform/process-list.ts:141` | J4 (annotated at site) |
| `src/platform/process-list.ts:163` | J3 (annotated at site) |
| `src/platform/ps-host.ts:95` | EXEMPT — `catch {}` inside the embedded PowerShell bootstrap string literal (issue-sanctioned exemption); real host script errors still emit the explicit `PSHOSTERR:` marker the TS side rejects on. |
| `src/platform/ps-host.ts:107` | EXEMPT — embedded PS literal; the catch WRITES an explicit `PSHOSTERR:` marker the TS side rejects on, so nothing is swallowed. |
| `src/platform/ps-host.ts:163` | J6 (annotated at site) |
| `src/platform/ps-host.ts:168` | J6 (annotated at site) |
| `src/platform/ps-host.ts:175` | J6 (annotated at site) |
| `src/platform/ps-host.ts:239` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/platform/ps-host.ts:272` | J1 (annotated at site) |
| `src/platform/ps-host.ts:303` | J5 (annotated immediately above the `.catch` — rejection observed by the documented consumer) |
| `src/platform/ps-host.ts:349` | J6 (annotated at site) |
| `src/platform/screenshot.ts:64` | J6 (annotated at site) |
| `src/platform/screenshot.ts:69` | J6 (annotated at site) |
| `src/platform/screenshot.ts:72` | J6 (annotated at site) |
| `src/platform/screenshot.ts:113` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/platform/screenshot.ts:191` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/platform/screenshot.ts:203` | J4 (annotated at site) |
| `src/platform/screenshot.ts:235` | J4 (annotated at site) |
| `src/platform/security.ts:239` | J3 (annotated at site) |
| `src/platform/security.ts:350` | J3 (annotated at site) |
| `src/platform/security.ts:379` | J3 (annotated at site) |
| `src/platform/wayland-portal.ts:169` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/platform/windows-list.ts:48` | J4 (annotated at site) — two-tier failover: script-level errors rethrow, host-level failures fall back to the cold one-shot spawn whose own failure propagates |
| `src/platform/windows-list.ts:247` | J4 (annotated at site) |
| `src/platform/windows-list.ts:309` | J4 (annotated at site) |
| `src/platform/windows-list.ts:346` | J4 (annotated at site) |
| `src/platform/windows-list.ts:393` | J4 (annotated at site) |
| `src/platform/windows-list.ts:415` | J3 (annotated at site) |
| `src/platform/windows-list.ts:435` | J4 (annotated at site) |
| `src/platform/windows-list.ts:503` | J4 (annotated at site) |
| `src/platform/windows-list.ts:660` | J4 (annotated at site) |
| `src/platform/windows-list.ts:1067` | J4 (annotated at site) |
| `src/platform/windows-list.ts:1094` | J4 (annotated at site) |
| `src/platform/windows-list.ts:1113` | J4 (annotated at site) |
| `src/platform/windows-list.ts:1134` | J4 (annotated at site) |
| `src/platform/windows-list.ts:1153` | J4 (annotated at site) |
| `src/platform/windows-list.ts:1175` | J4 (annotated at site) |
| `src/platform/windows-list.ts:1198` | J4 (annotated at site) |
| `src/providers/computer-state.ts:125` | J4 (annotated at site) |
| `src/providers/scene.ts:55` | J4 (annotated at site) |
| `src/routes/computer-use-compat-routes.ts:54` | J3 (annotated at site) |
| `src/routes/computer-use-compat-routes.ts:172` | J1 (annotated at site) |
| `src/routes/computer-use-compat-routes.ts:191` | J3 (annotated at site) |
| `src/routes/sandbox-routes.ts:103` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:137` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:150` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:163` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:214` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:240` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:261` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:274` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:288` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:348` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:381` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:404` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:427` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:450` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:476` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:496` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:514` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:539` | route-J1 — route boundary; failure becomes an explicit 4xx/5xx (or error-carrying) JSON payload (directory-documented) |
| `src/routes/sandbox-routes.ts:872` | J6 (annotated at site) |
| `src/routes/sandbox-routes.ts:877` | J6 (annotated at site) |
| `src/routes/sandbox-routes.ts:880` | J6 (annotated at site) |
| `src/routes/sandbox-routes.ts:921` | J4 (annotated at site) |
| `src/routes/sandbox-routes.ts:951` | J4 (annotated at site) |
| `src/routes/sandbox-routes.ts:976` | J4 (annotated at site) |
| `src/routes/sandbox-routes.ts:1046` | J6 (annotated at site) |
| `src/routes/sandbox-routes.ts:1085` | J6 (annotated at site) |
| `src/routes/sandbox-routes.ts:1362` | J3 (annotated at site) |
| `src/routes/sandbox-routes.ts:1372` | J3 (annotated at site) |
| `src/routes/sandbox-routes.ts:1382` | J3 (annotated at site) |
| `src/routes/sandbox-routes.ts:1406` | J3 (annotated at site) |
| `src/routes/sandbox-routes.ts:1446` | J4 (annotated at site) |
| `src/routes/sandbox-routes.ts:1479` | J4 (annotated at site) |
| `src/routes/sandbox-routes.ts:1495` | J4 (annotated at site) |
| `src/routes/sandbox-routes.ts:1513` | J1 (annotated at site) |
| `src/routes/sandbox-routes.ts:1531` | J3 (annotated at site) |
| `src/sandbox/docker-backend.ts:354` | J6 (annotated at site) |
| `src/sandbox/docker-backend.ts:397` | J3 (annotated at site) |
| `src/sandbox/remote-guest.ts:160` | J1 (annotated at site) |
| `src/scene/a11y-provider.ts:227` | J4 (annotated at site) |
| `src/scene/a11y-provider.ts:255` | J4 (annotated at site) |
| `src/scene/a11y-provider.ts:270` | J4 (annotated at site) |
| `src/scene/a11y-provider.ts:293` | J3 (annotated at site) |
| `src/scene/a11y-provider.ts:342` | J3 (annotated at site) |
| `src/scene/a11y-provider.ts:492` | FIXED (exemplar 2) — embedded JXA per-window catch now COUNTS the miss (`failed += 1`); reported once per scan via runtime.reportError("Computeruse.a11yScan", …). |
| `src/scene/a11y-provider.ts:494` | FIXED (exemplar 2) — embedded JXA per-process catch now counts the miss; reported once per scan. |
| `src/scene/a11y-provider.ts:511` | J4 (annotated at site) |
| `src/scene/a11y-provider.ts:612` | FIXED — embedded PS UIA per-element catch now counts the miss (`$failed++`); reported once per scan. |
| `src/scene/a11y-provider.ts:628` | J4 (annotated at site) |
| `src/scene/apps.ts:172` | J4 (annotated at site) |
| `src/scene/ocr-adapter.ts:110` | J4 (annotated at site) |
| `src/scene/ocr-adapter.ts:132` | J4 (annotated at site) |
| `src/scene/ocr-adapter.ts:177` | J4 (annotated at site) |
| `src/scene/ocr-adapter.ts:214` | J4 (annotated at site) |
| `src/scene/scene-builder.ts:332` | J4 (annotated at site) |
| `src/scene/scene-builder.ts:430` | J4 (annotated at site) |
| `src/scene/scene-builder.ts:441` | J4 (annotated at site) |
| `src/scene/scene-builder.ts:455` | J4 (annotated at site) |
| `src/scene/scene-builder.ts:489` | J4 (annotated at site) |
| `src/services/computer-use-service.ts:266` | J4 (annotated at site) |
| `src/services/computer-use-service.ts:297` | J6 (annotated at site) |
| `src/services/computer-use-service.ts:308` | J6 (annotated at site) |
| `src/services/computer-use-service.ts:633` | J4 (annotated at site) |
| `src/services/computer-use-service.ts:643` | J1 (annotated at site) |
| `src/services/computer-use-service.ts:733` | J1 (annotated at site) |
| `src/services/computer-use-service.ts:793` | J1 (annotated at site) |
| `src/services/computer-use-service.ts:829` | J1 (annotated at site) |
| `src/services/computer-use-service.ts:860` | J1 (annotated at site) |
| `src/services/computer-use-service.ts:1216` | J1 (annotated at site) |
| `src/services/computer-use-service.ts:1334` | J1 (annotated at site) |
| `src/services/computer-use-service.ts:1429` | J1 (annotated at site) |
| `src/services/computer-use-service.ts:1881` | J4 (annotated at site) |
| `src/services/computer-use-service.ts:2175` | J4 (annotated at site) |
| `src/services/desktop-control.ts:61` | J3 (annotated at site) |
| `src/services/desktop-control.ts:137` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/services/desktop-control.ts:170` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/services/desktop-control.ts:676` | rethrow — propagates (context-adding or permission-classifying throw); no swallow |
| `src/services/desktop-control.ts:688` | J3 (annotated at site) |
| `src/services/desktop-control.ts:709` | J3 (annotated at site) |
| `src/services/desktop-control.ts:719` | J6 (annotated at site) |
| `src/services/vision-context-provider.ts:163` | J4 (annotated at site) |
| `src/services/vision-context-provider.ts:193` | J4 (annotated at site) |
| `src/services/vision-context-provider.ts:205` | J4 (annotated at site) |

Totals: 214 catch sites — 174 J-kept rows carrying 172 `error-policy:J` annotations
(J1×38 · J3×35 · J4×75 · J5×4 · J6×18 · J7×2 by grep; adjacent best-effort-teardown
catches share one annotation where they express the same policy), 18
directory-documented route-J1, 16 rethrows, 6 embedded-script-literal rows (3 exempt
with explicit failure markers, 3 fixed by counting — the exemplar-2 empty catches).
