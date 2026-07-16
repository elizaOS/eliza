/**
 * Side-effect boot entry for @elizaos/plugin-personal-assistant.
 *
 * The renderer's `plugin-registrations` loader imports this once after first
 * paint (opted in via `elizaos.appRegister: "register"` in package.json), which
 * starts the LifeOps activity-signal capture for the app lifetime without the
 * GUI shell mounting a React effect. The capture guards itself on device
 * capability and runtime readiness, so starting it unconditionally here is safe
 * on every platform.
 */
import { startLifeOpsActivitySignalCapture } from "./lifeops/activity-signals-capture.js";

startLifeOpsActivitySignalCapture();
