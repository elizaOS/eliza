/**
 * @vitest-environment jsdom
 *
 * Verifies the top-level auth gate selects the managed-Cloud recovery notice
 * without regressing the self-hosted owner-password form.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AgentAuthGateSurface } from "../AgentAuthGateSurface";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());

describe("AgentAuthGateSurface", () => {
  it("renders Cloud reauth for a managed native target and no password fields", async () => {
    const onNativeReauth = vi.fn(async () => undefined);

    render(
      <AgentAuthGateSurface
        onLoginSuccess={vi.fn()}
        onNativeReauth={onNativeReauth}
        reason="remote_auth_required"
        showCloudReauth
      />,
    );

    expect(screen.getByText("Open this agent from Eliza Cloud")).toBeTruthy();
    expect(screen.queryByText("Display name")).toBeNull();
    expect(screen.queryByText("Password")).toBeNull();
    expect(screen.queryByText("Remember this device for 30 days")).toBeNull();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Re-open from Eliza Cloud" }),
      );
    });
    expect(onNativeReauth).toHaveBeenCalledOnce();
  });

  it("retains the owner-password form for self-hosted targets", () => {
    render(
      <AgentAuthGateSurface
        onLoginSuccess={vi.fn()}
        reason="remote_auth_required"
        showCloudReauth={false}
      />,
    );

    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.queryByText("Open this agent from Eliza Cloud")).toBeNull();
  });

  it("offers a non-destructive retry when Cloud auth was not rejected", async () => {
    const onNativeReauth = vi.fn(async () => undefined);

    render(
      <AgentAuthGateSurface
        nativeRecoveryMode="retry"
        onLoginSuccess={vi.fn()}
        onNativeReauth={onNativeReauth}
        reason="remote_auth_required"
        showCloudReauth
      />,
    );

    expect(screen.getByText("Reconnect to this Cloud agent")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(onNativeReauth).toHaveBeenCalledOnce();
  });

  it("offers Cloud management without pretending retry can fix configuration", async () => {
    const onNativeReauth = vi.fn(async () => undefined);
    const onNativeRetry = vi.fn(async () => undefined);

    render(
      <AgentAuthGateSurface
        nativeRecoveryMode="manage"
        onLoginSuccess={vi.fn()}
        onNativeReauth={onNativeReauth}
        onNativeRetry={onNativeRetry}
        reason="remote_password_not_configured"
        showCloudReauth
      />,
    );

    expect(screen.getByText("Manage this Cloud agent")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open Eliza Cloud" }));
    });
    expect(onNativeReauth).toHaveBeenCalledOnce();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "I fixed it — reconnect" }),
      );
    });
    expect(onNativeRetry).toHaveBeenCalledOnce();
  });
});
