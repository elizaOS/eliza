/** Verifies the macOS AX action wire request binds the captured process, window, and element generation. */

import { describe, expect, it } from "vitest";
import { createMacosAxPerformRequest } from "./macos-ax-adapter.js";

describe("createMacosAxPerformRequest", () => {
  it("carries exact PID, focused-window bounds, locator, role, subrole, label, and element bounds", () => {
    expect(
      createMacosAxPerformRequest(
        { id: "fixture.app", name: "Fixture", pid: 4242, active: true },
        {
          locator: [0, 2, 1],
          role: "AXButton",
          subrole: "AXCloseButton",
          label: "Delete",
          bounds: { x: 140, y: 240, width: 80, height: 40 },
          actions: ["AXPress"],
          enabled: true,
          focused: false,
          secure: false,
        },
        {
          app: "fixture.app",
          stateId: "fixture.app:state-1",
          kind: "click",
          element_index: 1,
        },
        { x: 100, y: 200, width: 800, height: 600 },
      ),
    ).toMatchObject({
      command: "perform",
      app: "fixture.app",
      pid: 4242,
      action: "click",
      expectedWindowBounds: { x: 100, y: 200, width: 800, height: 600 },
      locator: [0, 2, 1],
      expected: {
        role: "AXButton",
        subrole: "AXCloseButton",
        label: "Delete",
        bounds: { x: 140, y: 240, width: 80, height: 40 },
      },
    });
  });
});
