import { describe, expect, it, vi } from "vitest";

const registerOverlayApp = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", () => ({
  registerOverlayApp,
}));

import {
  registerTrajectoryLoggerApp,
  TRAJECTORY_LOGGER_APP_NAME,
  trajectoryLoggerApp,
} from "./trajectory-logger-app";

describe("trajectory logger overlay registration", () => {
  it("describes the trajectory logger overlay app", () => {
    expect(trajectoryLoggerApp).toMatchObject({
      name: TRAJECTORY_LOGGER_APP_NAME,
      displayName: "Trajectory Logger",
      category: "developer",
    });
    expect(trajectoryLoggerApp.loader).toEqual(expect.any(Function));
  });

  it("registers once across repeated calls", () => {
    registerTrajectoryLoggerApp();
    registerTrajectoryLoggerApp();

    expect(registerOverlayApp).toHaveBeenCalledTimes(1);
    expect(registerOverlayApp).toHaveBeenCalledWith(trajectoryLoggerApp);
  });
});
