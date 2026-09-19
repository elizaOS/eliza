/** Tests the local login handoff's navigation and account-switch failure boundaries. */
// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:21484/login"}
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  switchAccount: vi.fn(),
  assign: vi.fn(),
  clearBinding: vi.fn(),
}));
vi.mock("../../../../api", () => ({
  client: { cloudLoginDirect: mocks.start },
}));
vi.mock("../../../../api/client-cloud", () => ({
  resolveDirectCloudWebBase: () => "https://staging.eliza.app",
}));
vi.mock("../../../sso-bridge/sso-bridge", () => ({
  signOutFromSsoBridgedHost: mocks.switchAccount,
}));
vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts: { defaultValue: string }) =>
    opts.defaultValue,
}));

vi.mock("../../../../state/shared-cloud-account-binding", () => ({
  clearManagedCloudAccountBinding: mocks.clearBinding,
}));
vi.mock("../../../../state/cloud-pair-token", () => ({
  clearCloudPairApiToken: vi.fn(),
}));
vi.mock("../../../../state/persistence", () => ({
  savePersistedFirstRunComplete: vi.fn(),
}));

import LoopbackCloudLoginSection from "./loopback-cloud-login-section";

function requiredReturnTo(url: URL): string {
  const value = url.searchParams.get("returnTo");
  if (!value) throw new Error("Missing return destination");
  return value;
}

const originalLocation = window.location;
const sessionId = "97d189f6-552a-4984-85f1-51c95c0540e5";
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin: "http://localhost:21484", assign: mocks.assign },
  });
  mocks.switchAccount.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue({
    ok: true,
    sessionId,
    browserUrl: `https://staging.eliza.app/auth/cli-login?session=${sessionId}`,
  });
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
});

async function begin(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <LoopbackCloudLoginSection />
    </MemoryRouter>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Continue with Eliza Cloud" }),
  );
}

it.each([
  "/login",
  "/login?returnTo=%2Flogin",
  "/login?returnTo=%2F%2Fevil.example",
])(
  "returns %s through the app callback instead of looping into public login",
  async (path) => {
    await begin(path);
    await waitFor(() => expect(mocks.assign).toHaveBeenCalledOnce());
    const destination = new URL(mocks.assign.mock.calls[0][0]);
    expect(destination.origin).toBe("https://staging.eliza.app");
    const returnTo = new URL(requiredReturnTo(destination));
    expect(returnTo.origin).toBe("http://localhost:21484");
    expect(returnTo.pathname + returnTo.hash).toBe("/settings#cloud-overview");
    expect(returnTo.searchParams.get("elizaCloudLoginSession")).toBe(sessionId);
  },
);

it.each(["/", "/chat"])(
  "offers agent selection after account switching instead of returning to %s without an agent",
  async (path) => {
    await begin(`/login?switchAccount=1&returnTo=${encodeURIComponent(path)}`);
    await waitFor(() => expect(mocks.assign).toHaveBeenCalledOnce());
    const login = new URL(mocks.assign.mock.calls[0][0]);
    const handoff = new URL(requiredReturnTo(login), login.origin);
    const returnTo = new URL(requiredReturnTo(handoff));
    expect(mocks.clearBinding).toHaveBeenCalledOnce();
    expect(returnTo.pathname + returnTo.hash).toBe("/settings#cloud-overview");
    expect(returnTo.searchParams.get("elizaCloudLoginSession")).toBe(sessionId);
  },
);

it("retains an explicit chat return when the existing agent binding is preserved", async () => {
  await begin("/login?returnTo=%2Fchat");
  await waitFor(() => expect(mocks.assign).toHaveBeenCalledOnce());
  const handoff = new URL(mocks.assign.mock.calls[0][0]);
  const returnTo = new URL(requiredReturnTo(handoff));
  expect(mocks.clearBinding).not.toHaveBeenCalled();
  expect(returnTo.pathname).toBe("/chat");
});

it.each(["/cloud/billing", "/cloud/agents?filter=idle#agent"])(
  "claims a CLI return before entering the authenticated account route %s",
  async (path) => {
    await begin(`/login?returnTo=${encodeURIComponent(path)}`);
    await waitFor(() => expect(mocks.assign).toHaveBeenCalledOnce());
    const handoff = new URL(mocks.assign.mock.calls[0][0]);
    const returnTo = new URL(requiredReturnTo(handoff));
    expect(returnTo.pathname).toBe("/settings");
    expect(returnTo.searchParams.get("elizaCloudLoginReturnTo")).toBe(path);
    expect(returnTo.searchParams.get("elizaCloudLoginSession")).toBe(sessionId);
  },
);

it("preserves a safe app destination and performs explicit account switching on both origins", async () => {
  await begin("/login?switchAccount=1&returnTo=%2Fsettings%23cloud-overview");
  await waitFor(() => expect(mocks.assign).toHaveBeenCalledOnce());
  expect(mocks.switchAccount).toHaveBeenCalledOnce();
  expect(mocks.clearBinding).toHaveBeenCalledOnce();
  const login = new URL(mocks.assign.mock.calls[0][0]);
  expect(login.pathname).toBe("/login");
  expect(login.searchParams.get("switchAccount")).toBe("1");
  const handoff = new URL(requiredReturnTo(login), login.origin);
  expect(handoff.pathname).toBe("/auth/cli-login");
  const returnTo = new URL(requiredReturnTo(handoff));
  expect(returnTo.pathname + returnTo.hash).toBe("/settings#cloud-overview");
});

it("keeps the previous account intact when teardown cannot complete", async () => {
  mocks.switchAccount.mockRejectedValue(
    new Error("Session teardown unavailable"),
  );
  await begin("/login?switchAccount=1");
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Session teardown unavailable",
  );
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.clearBinding).not.toHaveBeenCalled();
  expect(mocks.assign).not.toHaveBeenCalled();
});

it("rejects an unexpected authorization origin and allows retry", async () => {
  mocks.start.mockResolvedValueOnce({
    ok: true,
    sessionId,
    browserUrl: `https://evil.example/auth/cli-login?session=${sessionId}`,
  });
  await begin("/login");
  expect((await screen.findByRole("alert")).textContent).toContain(
    "invalid sign-in link",
  );
  expect(mocks.assign).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Continue with Eliza Cloud" }),
  );
  await waitFor(() => expect(mocks.assign).toHaveBeenCalledOnce());
});
