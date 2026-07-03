// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { applyRouteGate } from "./CloudRouterShell";
import {
  getCloudRouteGate,
  registerCloudRouteGate,
} from "./cloud-route-registry";

/**
 * Central route gating (#12087 Item 23). The shell — not each route body —
 * enforces `CloudRouteDef.gate`, so a route declaring `gate: "admin"` is gated
 * even if its body forgets to wrap itself, and an unknown gate fails closed.
 */

afterEach(cleanup);

describe("applyRouteGate", () => {
  it("wraps a route body in the registered gate even when the body does NOT gate itself", () => {
    registerCloudRouteGate(
      "test-gate",
      ({ children }: { children: ReactNode }) => (
        <div data-testid="gate-wrapper">{children}</div>
      ),
    );
    render(
      <>{applyRouteGate("test-gate", <div data-testid="ungated-body" />)}</>,
    );
    // The body carried no gate of its own, yet the shell applied one.
    expect(screen.getByTestId("gate-wrapper")).toBeTruthy();
    expect(screen.getByTestId("ungated-body")).toBeTruthy();
  });

  it("fails closed when a declared gate has no registered implementation", () => {
    render(
      <>{applyRouteGate("no-such-gate", <div data-testid="secret-body" />)}</>,
    );
    expect(screen.queryByTestId("secret-body")).toBeNull();
    expect(screen.getByText("Access unavailable")).toBeTruthy();
  });

  it("renders the body ungated when no gate is declared", () => {
    render(<>{applyRouteGate(undefined, <div data-testid="public-body" />)}</>);
    expect(screen.getByTestId("public-body")).toBeTruthy();
  });
});

describe("admin routes declare the gate instead of self-wrapping", () => {
  it("registers the admin gate and declares gate: 'admin' on every admin route", async () => {
    const admin = await import("../admin");
    expect(getCloudRouteGate("admin")).toBeDefined();
    expect(admin.adminModerationCloudRoute.gate).toBe("admin");
    expect(admin.adminRedemptionsCloudRoute.gate).toBe("admin");
    expect(admin.adminRpcStatusCloudRoute.gate).toBe("admin");
  });
});
