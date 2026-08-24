/** Verifies dispatch capabilities never confuse process events with exact-window delivery. */

import { describe, expect, it } from "vitest";
import { getAppControlRouteMatrix } from "./route-policy.js";

describe("app-control route policy", () => {
  it("blocks exact-window pointer dispatch in the shared signed bundle", () => {
    const routes = getAppControlRouteMatrix({
      globalPhysicalFallbackEnabled: false,
    });
    expect(
      routes.find((route) => route.id === "exact_window_pointer"),
    ).toMatchObject({
      status: "policy_blocked",
      deliveryScope: "window",
      pointerEffect: "none",
      exactWindowDelivery: false,
    });
  });

  it("labels PID keyboard delivery as process-scoped and conditional", () => {
    const routes = getAppControlRouteMatrix();
    expect(
      routes.find((route) => route.id === "process_pid_keyboard"),
    ).toMatchObject({
      status: "conditional",
      deliveryScope: "process",
      exactWindowDelivery: false,
      pointerEffect: "none",
    });
  });

  it("reports a packaged direct-only component as experimental and disabled", () => {
    const routes = getAppControlRouteMatrix({
      experimentalExactWindowComponentPresent: true,
    });
    expect(
      routes.find((route) => route.id === "exact_window_pointer"),
    ).toMatchObject({
      status: "disabled_by_default",
      deliveryScope: "window",
      exactWindowDelivery: false,
      pointerEffect: "none",
    });
  });

  it("never enables global physical input implicitly", () => {
    const disabled = getAppControlRouteMatrix({
      globalPhysicalFallbackEnabled: false,
    });
    const optedIn = getAppControlRouteMatrix({
      globalPhysicalFallbackEnabled: true,
    });
    expect(
      disabled.find((route) => route.id === "global_physical_pointer"),
    ).toMatchObject({
      status: "disabled_by_default",
      deliveryScope: "host_global",
      exactWindowDelivery: false,
      pointerEffect: "physical",
    });
    expect(
      optedIn.find((route) => route.id === "global_physical_pointer"),
    ).toMatchObject({ status: "conditional" });
  });

  it("keeps public pointer-free and isolated routes independently visible", () => {
    const routes = getAppControlRouteMatrix();
    expect(routes.map((route) => [route.id, route.status])).toEqual(
      expect.arrayContaining([
        ["semantic_ax", "supported"],
        ["browser_cdp", "supported"],
        ["isolated_target", "conditional"],
      ]),
    );
  });
});
