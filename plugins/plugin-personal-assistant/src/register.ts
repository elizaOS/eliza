/**
 * Renderer registration entry for @elizaos/plugin-personal-assistant. The app
 * shell imports this once after first paint (opted in via
 * `elizaos.appRegister: "register"` in package.json) in every renderer window
 * — so it must not start work at import time. Instead it registers the LifeOps
 * activity-signal capture as a lifecycle-scoped renderer service: the host
 * starts it only in main app windows (never popouts, detached shells, the
 * phone companion, app windows, or the model tester), retains the returned
 * stop function, and invokes it on page teardown, host replacement, and HMR
 * re-registration (#16504).
 */
import { registerRendererService } from "@elizaos/ui/platform/renderer-services";
import { startLifeOpsActivitySignalCapture } from "./lifeops/activity-signals-capture.js";

registerRendererService({
  id: "personal-assistant.lifeops-activity-signals",
  shells: ["main"],
  start: () => startLifeOpsActivitySignalCapture(),
});
