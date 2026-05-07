/**
 * Overlay app definition + registration for the Trajectory Logger app.
 */

import { type OverlayApp, registerOverlayApp } from "@elizaos/app-core";
import { TrajectoryLoggerView } from "./TrajectoryLoggerView";

export const TRAJECTORY_LOGGER_APP_NAME = "@elizaos/app-trajectory-logger";

export const trajectoryLoggerApp: OverlayApp = {
  name: TRAJECTORY_LOGGER_APP_NAME,
  displayName: "Trajectory Logger",
  description:
    "Realtime view of the agent's last and pending turns — HANDLE / PLAN / ACTION / EVALUATE.",
  category: "developer",
  icon: null,
  Component: TrajectoryLoggerView,
};

let registered = false;

export function registerTrajectoryLoggerApp(): void {
  if (registered) return;
  registerOverlayApp(trajectoryLoggerApp);
  registered = true;
}
