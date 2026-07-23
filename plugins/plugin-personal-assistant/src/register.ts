/**
 * Side-effect boot entry for @elizaos/plugin-personal-assistant.
 *
 * The renderer's `plugin-registrations` loader imports this once after first
 * paint (opted in via `elizaos.appRegister: "register"` in package.json),
 * starting the LifeOps activity-signal capture for the app lifetime without
 * the GUI shell mounting a React effect (#16504).
 *
 * Renderer scope: capture runs only in the primary main-window app shell.
 * Popouts, detached surface/settings windows, chat overlays, tray popovers,
 * the phone companion, `/apps/<slug>` windows, and the model tester boot the
 * same bundle and would each double-report presence — `isPrimaryAppRenderer`
 * (the @elizaos/ui renderer-scope contract) excludes them. The controller
 * itself is an idempotent singleton and also guards on device capability and
 * runtime readiness, so starting it unconditionally in-scope is safe on every
 * platform. Exports nothing by design: the app shell must never consume
 * plugin API through this entry (the root facade owns that surface).
 */
// The /platform subpath, not the root barrel: this entry evaluates at app boot
// and must not pull the full component/router tree into its chunk.
import { isPrimaryAppRenderer } from "@elizaos/ui/platform";
import { startLifeOpsActivitySignalCapture } from "./lifeops/activity-signals-capture.js";

// Vite provides `import.meta.hot` in dev only and tsc compiles this package
// without vite/client ambient types, so narrow the shape structurally.
const hot = (
  import.meta as ImportMeta & {
    hot?: { dispose(callback: () => void): void };
  }
).hot;

const stop = isPrimaryAppRenderer() ? startLifeOpsActivitySignalCapture() : null;

// HMR replaces this module with a fresh evaluation; dispose the old capture
// first so the replacement's start is a clean singleton claim, not a leak.
hot?.dispose(() => {
  stop?.();
});
