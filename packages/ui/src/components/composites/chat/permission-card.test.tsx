// @vitest-environment jsdom

import type {
  IPermissionsRegistry,
  PermissionId,
  PermissionState,
} from "@elizaos/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PermissionCard,
  parsePermissionRequestFromText,
} from "./permission-card";

afterEach(() => {
  cleanup();
});

function makeRegistry(
  initial: PermissionState,
  overrides: Partial<IPermissionsRegistry> = {},
): IPermissionsRegistry {
  return {
    get: vi.fn(() => initial),
    check: vi.fn(async () => initial),
    request: vi.fn(async () => initial),
    recordBlock: vi.fn(),
    list: vi.fn(() => [initial]),
    pending: vi.fn(() => []),
    subscribe: vi.fn(() => () => {}),
    registerProber: vi.fn(),
    ...overrides,
  };
}

function state(
  overrides: Omit<PermissionState, "platform"> &
    Partial<Pick<PermissionState, "platform">>,
): PermissionState {
  return { platform: "darwin", ...overrides };
}

const baseProps = {
  permission: "reminders" as PermissionId,
  reason: "I'd like to add 'pick up groceries' to your Apple Reminders.",
  feature: "lifeops.reminders.create",
};

describe("PermissionCard", () => {
  it("renders the friendly title and reason for not-determined state", () => {
    render(
      <PermissionCard
        {...baseProps}
        initialState={{
          id: "reminders",
          status: "not-determined",
          lastChecked: 0,
          canRequest: true,
          platform: "darwin",
        }}
      />,
    );
    expect(screen.getByText("Apple Reminders")).toBeTruthy();
    expect(screen.getByText(baseProps.reason)).toBeTruthy();
    expect(
      (screen.getByTestId("permission-card-primary") as HTMLButtonElement)
        .textContent,
    ).toContain("Grant access");
  });

  it("calls registry.request and reports granted on success", async () => {
    const grantedState: PermissionState = state({
      id: "reminders",
      status: "granted",
      lastChecked: 1,
      canRequest: false,
    });
    const registry = makeRegistry(
      state({
        id: "reminders",
        status: "not-determined",
        lastChecked: 0,
        canRequest: true,
      }),
      { request: vi.fn(async () => grantedState) },
    );
    const onGranted = vi.fn();
    render(
      <PermissionCard
        {...baseProps}
        registry={registry}
        onGranted={onGranted}
      />,
    );

    const btn = screen.getByTestId("permission-card-primary");
    fireEvent.click(btn);
    // findByTestId waits for the granted confirmation to appear after the
    // async request resolves and the component re-renders.
    await screen.findByTestId("permission-card-granted");

    expect(registry.request).toHaveBeenCalledWith("reminders", {
      reason: baseProps.reason,
      feature: { app: "lifeops", action: "reminders.create" },
    });
    expect(onGranted).toHaveBeenCalledWith(grantedState);
  });

  it("renders 'Open System Settings' when denied and canRequest is false", () => {
    render(
      <PermissionCard
        {...baseProps}
        initialState={{
          id: "reminders",
          status: "denied",
          lastChecked: 0,
          canRequest: false,
          platform: "darwin",
        }}
      />,
    );
    expect(
      (screen.getByTestId("permission-card-primary") as HTMLButtonElement)
        .textContent,
    ).toContain("Open System Settings");
  });

  it("renders disabled 'Coming soon' when restricted by entitlement", () => {
    render(
      <PermissionCard
        {...baseProps}
        permission="health"
        initialState={{
          id: "health",
          status: "restricted",
          restrictedReason: "entitlement_required",
          lastChecked: 0,
          canRequest: false,
          platform: "darwin",
        }}
      />,
    );
    const btn = screen.getByTestId(
      "permission-card-primary",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Coming soon");
  });

  it("auto-collapses to 'Access granted' when initial state is granted", () => {
    render(
      <PermissionCard
        {...baseProps}
        initialState={{
          id: "reminders",
          status: "granted",
          lastChecked: 0,
          canRequest: false,
          platform: "darwin",
        }}
      />,
    );
    expect(screen.getByTestId("permission-card-granted")).toBeTruthy();
    expect(screen.queryByTestId("permission-card")).toBeNull();
  });

  it("dismisses on 'Not now'", () => {
    const onDismiss = vi.fn();
    render(
      <PermissionCard
        {...baseProps}
        initialState={{
          id: "reminders",
          status: "not-determined",
          lastChecked: 0,
          canRequest: true,
          platform: "darwin",
        }}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByTestId("permission-card-dismiss"));
    expect(onDismiss).toHaveBeenCalled();
    expect(screen.queryByTestId("permission-card")).toBeNull();
  });

  it("emits fallback choice when offered and clicked", () => {
    const onFallback = vi.fn();
    render(
      <PermissionCard
        {...baseProps}
        fallbackOffered
        fallbackLabel="Use internal reminders instead"
        initialState={{
          id: "reminders",
          status: "not-determined",
          lastChecked: 0,
          canRequest: true,
          platform: "darwin",
        }}
        onFallback={onFallback}
      />,
    );
    fireEvent.click(screen.getByTestId("permission-card-fallback"));
    expect(onFallback).toHaveBeenCalledWith({
      type: "use_fallback",
      feature: "lifeops.reminders.create",
      permission: "reminders",
    });
    expect(screen.queryByTestId("permission-card")).toBeNull();
  });

  it("parsePermissionRequestFromText extracts fenced permission_request", () => {
    const text =
      "I can add that.\n```json\n" +
      '{"action":"permission_request","reasoning":"x","permission":"reminders","reason":"add groceries","feature":"lifeops.reminders.create","fallback_offered":true,"fallback_label":"Use internal reminders"}' +
      "\n```";
    const result = parsePermissionRequestFromText(text);
    expect(result).not.toBeNull();
    expect(result?.display).toBe("I can add that.");
    expect(result?.payload.permission).toBe("reminders");
    expect(result?.payload.fallbackOffered).toBe(true);
    expect(result?.payload.fallbackLabel).toBe("Use internal reminders");
  });

  it("parsePermissionRequestFromText returns null for non-permission actions", () => {
    expect(
      parsePermissionRequestFromText(
        '```json\n{"action":"respond","reasoning":"x","response":"hi"}\n```',
      ),
    ).toBeNull();
  });

  it("hides fallback button when fallbackOffered is false", () => {
    render(
      <PermissionCard
        {...baseProps}
        initialState={{
          id: "reminders",
          status: "not-determined",
          lastChecked: 0,
          canRequest: true,
          platform: "darwin",
        }}
      />,
    );
    expect(screen.queryByTestId("permission-card-fallback")).toBeNull();
  });
});
