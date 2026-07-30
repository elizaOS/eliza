/**
 * Public task-coordinator package surface for hosts and view bundles.
 *
 * The runtime-only plugin definition lives at `./plugin` so headless and
 * bundled-mobile agents do not evaluate React, Lucide, or the dashboard UI.
 */

export { ProjectSwitcher } from "./ProjectSwitcher";
export * from "./plugin";
export { default } from "./plugin";
