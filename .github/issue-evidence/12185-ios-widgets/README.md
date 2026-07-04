# #12185 — iOS ElizaWidgets extension: widgets + iOS 18 controls + Action Button voice

Captured on the iOS simulator (iPhone 17 Pro, iOS 26.4 runtime; app deployment
target 16.0, controls gated iOS 18+), Xcode 26.4.1. Driven by the committed
`AppUITests/WidgetGalleryCaptureUITests` SpringBoard harness via
`node scripts/ios-device-capture.mjs --platform sim --only-testing AppUITests/WidgetGalleryCaptureUITests`.

| File | What it proves |
|---|---|
| `01-app-launched-versioned-build.png` | Versioned build (ELIZAOS_VERSION_NAME=1.12185.7 / CODE=1218507 threaded to MARKETING_VERSION / CURRENT_PROJECT_VERSION) installed + booted (iPhone 16, iOS 18.1 sim). |
| `02/03-*` | Home screen + jiggle mode entry into the widget gallery. |
| `04-widget-gallery-search-eliza.png` | Widget gallery search "Eliza" → elizaOS listed. |
| `05-widget-detail-small.png` | "Eliza Quick Actions" systemSmall detail page. |
| `06-widget-detail-medium-5-actions.png` | systemMedium with all five quick actions (Ask · Voice · Brief · Task · Reply). |
| `07-widget-added-to-home.png` | Widget added to the Home Screen. |
| `08/09/10-*` | Control Center → edit mode → controls gallery. |
| `11-control-gallery-search-ask-eliza-eliza-voice.png` | Controls gallery search "Eliza" → **Ask Eliza** + **Eliza Voice** controls registered (the same gallery feeds Control Center, Lock Screen, and the Action button picker). |
| `12-widget-control-gallery-walkthrough.mp4` | Video walkthrough of both gallery flows (recorded during the passing harness run). |
| `13/14-*` | Real tap on the home-screen widget's "Ask" action → app foregrounds via `elizaos://assistant?source=ios-widget&action=ask` (no external-open dialog; user-initiated Link). |

N/A rows:

- **Action Button hardware press**: N/A — the simulator has no Action button
  hardware. The controls gallery (`11-*`) is the exact picker the
  Settings → Action Button → Controls flow uses; setup path documented in
  `packages/app/docs/native-assistant-integration-plan.md`.
- **Real device capture**: N/A for this PR — no signing-provisioned physical
  device in the loop; the extension is target- and entitlement-identical on
  device (automatic signing, same App Group), and the device lane
  (`ios:device:deploy`) already grafts per-appex profiles.
- **Real-LLM trajectory**: N/A — no agent/action/provider/prompt/model behavior
  changed; this PR adds native OS entry points that mint the same deep links as
  the existing (already-shipped) App Intents.

Simulator signing gotcha (documented in the harness header): a
`CODE_SIGNING_ALLOWED=NO` build registers the widgets but control enumeration
faults (EXC_GUARD in XPC peer attribution) and the controls never appear in the
gallery — build with at least ad-hoc signing before capturing controls.
