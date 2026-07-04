// @vitest-environment jsdom

/**
 * Behaviour coverage for RoleGate: renders children only when the current role
 * (from `RoleProvider`) meets the gate. Real render in jsdom.
 */

import type { RoleGateRole } from "@elizaos/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RoleProvider, useRole } from "../hooks/useRole.tsx";
import { RoleGate } from "./RoleGate.tsx";

afterEach(() => {
  cleanup();
});

const OWNER: RoleGateRole = "OWNER";
const ADMIN: RoleGateRole = "ADMIN";
const USER: RoleGateRole = "USER";

function Secret() {
  return <div data-testid="secret">wallet</div>;
}

describe("RoleGate", () => {
  it("renders children for a role that meets minRole", () => {
    render(
      <RoleProvider role={OWNER}>
        <RoleGate minRole="OWNER">
          <Secret />
        </RoleGate>
      </RoleProvider>,
    );
    expect(screen.queryByTestId("secret")).toBeTruthy();
  });

  it("hides children (and shows fallback) for a role below minRole", () => {
    render(
      <RoleProvider role={USER}>
        <RoleGate minRole="OWNER" fallback={<span data-testid="denied" />}>
          <Secret />
        </RoleGate>
      </RoleProvider>,
    );
    expect(screen.queryByTestId("secret")).toBeNull();
    expect(screen.queryByTestId("denied")).toBeTruthy();
  });

  it("defaults to GUEST (no leak) without a provider", () => {
    render(
      <RoleGate minRole="ADMIN">
        <Secret />
      </RoleGate>,
    );
    expect(screen.queryByTestId("secret")).toBeNull();
  });

  it("supports anyOf and noneOf", () => {
    render(
      <RoleProvider role={ADMIN}>
        <RoleGate anyOf={["ADMIN", "OWNER"]}>
          <div data-testid="a" />
        </RoleGate>
        <RoleGate noneOf={["ADMIN"]}>
          <div data-testid="b" />
        </RoleGate>
      </RoleProvider>,
    );
    expect(screen.queryByTestId("a")).toBeTruthy();
    expect(screen.queryByTestId("b")).toBeNull();
  });
});

function RoleProbe() {
  const { role, isOwner, isAdmin, atLeast } = useRole();
  return (
    <div
      data-testid="probe"
      data-role={role}
      data-owner={String(isOwner)}
      data-admin={String(isAdmin)}
      data-at-least-user={String(atLeast("USER"))}
    />
  );
}

describe("useRole", () => {
  it("reports OWNER as owner+admin", () => {
    render(
      <RoleProvider role={OWNER}>
        <RoleProbe />
      </RoleProvider>,
    );
    const el = screen.getByTestId("probe");
    expect(el.getAttribute("data-owner")).toBe("true");
    expect(el.getAttribute("data-admin")).toBe("true");
  });

  it("reports ADMIN as admin but not owner", () => {
    render(
      <RoleProvider role={ADMIN}>
        <RoleProbe />
      </RoleProvider>,
    );
    const el = screen.getByTestId("probe");
    expect(el.getAttribute("data-owner")).toBe("false");
    expect(el.getAttribute("data-admin")).toBe("true");
  });

  it("reports USER as neither, but atLeast(USER) true", () => {
    render(
      <RoleProvider role={USER}>
        <RoleProbe />
      </RoleProvider>,
    );
    const el = screen.getByTestId("probe");
    expect(el.getAttribute("data-owner")).toBe("false");
    expect(el.getAttribute("data-admin")).toBe("false");
    expect(el.getAttribute("data-at-least-user")).toBe("true");
  });
});
