/** Verifies detached Settings authorization context through the real shell and role gate with a controlled auth snapshot. */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { DetachedShellRoot } from "./DetachedShellRoot";

const setup = vi.hoisted(() => ({ complete: true }));
const auth = vi.hoisted(() => ({ phase: "authenticated", role: "OWNER" }));
vi.mock("../../../../ui/src/hooks/useAuthStatus", () => ({
  useAuthStatus: () => ({
    state: { phase: auth.phase, access: { role: auth.role, mode: "session" } },
  }),
}));
vi.mock("../../../../ui/src/state/useApp", () => ({
  useApp: () => ({
    firstRunComplete: setup.complete,
    authRequired: false,
    startupError: null,
    actionNotice: null,
    t: (key: string) => key,
  }),
}));
vi.mock("../../../../ui/src/components/workspace/AppWorkspaceChrome", () => ({
  AppWorkspaceChrome: ({ main }: { main: ReactNode }) => main,
}));
vi.mock("../../../../ui/src/components/pages/PluginsPageView", () => ({
  PluginsPageView: () => null,
}));
vi.mock("../../../../ui/src/components/shell/ActionNoticeToast", () => ({
  ActionNoticeToast: () => null,
}));
vi.mock("../../../../ui/src/components/shell/PairingView", () => ({
  PairingView: () => null,
}));
vi.mock("../../../../ui/src/components/shell/StartupFailureView", () => ({
  StartupFailureView: () => null,
}));
vi.mock("../../../../ui/src/components/pages/SettingsView", async () => {
  const { RoleGate } = await import("../../../../ui/src/components/RoleGate");
  return {
    SettingsView: () => (
      <RoleGate minRole="OWNER" fallback={<p>Access denied</p>}>
        <button type="button">Manage credentials</button>
      </RoleGate>
    ),
  };
});
afterEach(() => {
  cleanup();
  setup.complete = true;
  auth.phase = "authenticated";
  auth.role = "OWNER";
});
it("allows the authenticated owner and revokes access when the session role changes", async () => {
  const { rerender } = render(
    <DetachedShellRoot route={{ mode: "settings" }} />,
  );
  expect(
    await screen.findByRole("button", { name: "Manage credentials" }),
  ).toBeTruthy();
  auth.role = "USER";
  rerender(<DetachedShellRoot route={{ mode: "settings" }} />);
  expect(
    screen.queryByRole("button", { name: "Manage credentials" }),
  ).toBeNull();
  expect(screen.getByText("Access denied")).toBeTruthy();
  auth.role = "OWNER";
  auth.phase = "unauthenticated";
  rerender(<DetachedShellRoot route={{ mode: "settings" }} />);
  expect(
    screen.queryByRole("button", { name: "Manage credentials" }),
  ).toBeNull();
  auth.phase = "authenticated";
  rerender(<DetachedShellRoot route={{ mode: "settings" }} />);
  expect(
    screen.getByRole("button", { name: "Manage credentials" }),
  ).toBeTruthy();
});

it("allows setup recovery in Settings while keeping other windows blocked", async () => {
  setup.complete = false;
  const { rerender } = render(
    <DetachedShellRoot route={{ mode: "settings" }} />,
  );
  expect(
    await screen.findByRole("button", { name: "Manage credentials" }),
  ).toBeTruthy();
  auth.phase = "unauthenticated";
  rerender(<DetachedShellRoot route={{ mode: "settings" }} />);
  expect(
    screen.queryByRole("button", { name: "Manage credentials" }),
  ).toBeNull();
  auth.phase = "authenticated";
  rerender(<DetachedShellRoot route={{ mode: "surface", tab: "chat" }} />);
  expect(screen.getByTestId("first-run-blocked-view")).toBeTruthy();
});
