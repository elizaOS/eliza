// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  session: {
    ready: true,
    authenticated: true,
    user: { id: "steward-a", email: "unverified-storage@example.test" },
  } as {
    ready: boolean;
    authenticated: boolean;
    user: { id: string; email: string } | null;
  },
  params: new URLSearchParams("session=bbbbbbbb-2222-4333-8444-cccccccccccc"),
  navigate: vi.fn(),
  profile: vi.fn(),
  complete: vi.fn(),
  signOut: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => fixtures.navigate,
  useSearchParams: () => [fixtures.params, vi.fn()],
}));
vi.mock("../../../../lib/use-session-auth", () => ({
  useSessionAuth: () => fixtures.session,
}));
vi.mock("../../../../lib/use-document-title", () => ({
  useDocumentTitle: () => {},
}));
vi.mock("../../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));
vi.mock("../../../../shell/StewardProvider", () => ({
  clearStaleStewardSession: fixtures.signOut,
}));
vi.mock("../../../../lib/api-client", () => ({
  api: fixtures.profile,
  apiFetch: fixtures.complete,
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("../../../../cloud-auth-complete-signal", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../cloud-auth-complete-signal")
  >()),
  publishCloudAuthComplete: fixtures.publish,
}));

import { ApiError } from "../../../../lib/api-client";
import CliLoginPage from "../cli-login-page";

const clients: QueryClient[] = [];
const profile = (
  email: string | null = "carson@example.test",
  id = "cloud-a",
) => ({
  success: true,
  data: {
    id,
    email,
    name: email ? "Carson" : null,
    organization_id: "org-a",
    steward_user_id: "steward-a",
    role: "owner",
    is_active: true,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    organization: {
      id: "org-a",
      name: "Carson workspace",
      slug: "carson",
      billing_email: null,
      credit_balance: "0",
      is_active: true,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    },
  },
});
function view() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  );
  const rendered = render(wrap(<CliLoginPage />));
  return {
    ...rendered,
    rerenderPage: () => rendered.rerender(wrap(<CliLoginPage />)),
  };
}
beforeEach(() => {
  fixtures.session = {
    ready: true,
    authenticated: true,
    user: { id: "steward-a", email: "unverified-storage@example.test" },
  };
  fixtures.params = new URLSearchParams(
    "session=bbbbbbbb-2222-4333-8444-cccccccccccc",
  );
  fixtures.publish.mockReset();
  fixtures.navigate.mockReset();
  fixtures.profile.mockReset().mockResolvedValue(profile());
  fixtures.complete
    .mockReset()
    .mockResolvedValue({ json: async () => ({ keyPrefix: "ek_test_only" }) });
  fixtures.signOut.mockReset().mockResolvedValue(undefined);
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const c of clients) c.clear();
  clients.length = 0;
});
describe("CLI account identity from the existing server-backed profile hook", () => {
  it("shows server account/org and keeps completion behind explicit authorization", async () => {
    view();
    await screen.findByText("carson@example.test");
    expect(screen.getByText("Carson workspace")).toBeTruthy();
    expect(screen.queryByText("unverified-storage@example.test")).toBeNull();
    expect(fixtures.profile).toHaveBeenCalledWith("/api/v1/user");
    expect(fixtures.complete).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Authorize" }),
    );
    await waitFor(() => expect(fixtures.complete).toHaveBeenCalledTimes(1));
  });
  it("blocks Authorize while account resolution is pending and allows Cancel", async () => {
    fixtures.profile.mockImplementation(() => new Promise(() => {}));
    view();
    expect(
      (
        screen.getByRole("button", {
          name: "Authorize",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel" }),
    );
    expect(fixtures.complete).not.toHaveBeenCalled();
  });
  it("does not present a native key placeholder as server-confirmed identity", async () => {
    fixtures.session.user = { id: "native-api-key:fixture", email: "" };
    fixtures.profile.mockRejectedValue(new Error("offline"));
    view();
    await screen.findByText(
      "Unable to verify your account. Reload this page or use a different account.",
    );
    expect(screen.queryByText("native-api-key:fixture")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Authorize",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(fixtures.complete).not.toHaveBeenCalled();
  });
  it("identifies a server account with no email without inventing one", async () => {
    fixtures.profile.mockResolvedValue(profile(null));
    view();
    await screen.findByText("cloud-a");
    expect(screen.queryByText("unverified-storage@example.test")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Authorize",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it("switches only after an explicit account-switch action and retains callback", async () => {
    view();
    await screen.findByText("carson@example.test");
    expect(fixtures.signOut).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );
    await waitFor(() =>
      expect(fixtures.navigate).toHaveBeenCalledWith(
        "/login?returnTo=" +
          encodeURIComponent(
            "/auth/cli-login?session=bbbbbbbb-2222-4333-8444-cccccccccccc",
          ),
        { replace: true },
      ),
    );
    expect(fixtures.signOut).toHaveBeenCalledTimes(1);
    expect(fixtures.complete).not.toHaveBeenCalled();
  });
  it("shows a switch failure without completing or navigating", async () => {
    fixtures.signOut.mockRejectedValue(new Error("storage hold"));
    view();
    await screen.findByText("carson@example.test");
    await userEvent.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );
    await screen.findByRole("alert");
    expect(fixtures.navigate).not.toHaveBeenCalled();
    expect(fixtures.complete).not.toHaveBeenCalled();
  });
  it("uses the new authority query namespace and ignores a late profile response", async () => {
    let resolveA: (value: ReturnType<typeof profile>) => void = () => {};
    fixtures.profile
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockResolvedValue(profile("second@example.test", "cloud-b"));
    const v = view();
    fixtures.session = {
      ...fixtures.session,
      user: { id: "steward-b", email: "unverified-b@example.test" },
    };
    v.rerenderPage();
    await screen.findByText("second@example.test");
    resolveA(profile());
    await waitFor(() =>
      expect(screen.queryByText("carson@example.test")).toBeNull(),
    );
    expect(fixtures.complete).not.toHaveBeenCalled();
  });
  it("keeps Cancel free of completion after the server identity is displayed", async () => {
    view();
    await screen.findByText("carson@example.test");
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel" }),
    );
    expect(fixtures.complete).not.toHaveBeenCalled();
  });
  it("ignores an in-flight completion after an account switch and requires a fresh Authorize for B", async () => {
    let finishA: (response: {
      json: () => Promise<{ keyPrefix: string }>;
    }) => void = () => {};
    fixtures.complete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishA = resolve;
        }),
    );
    const v = view();
    await screen.findByText("carson@example.test");
    await userEvent.click(
      screen.getByRole("button", { name: "Authorize" }),
    );
    await waitFor(() => expect(fixtures.complete).toHaveBeenCalledTimes(1));
    fixtures.profile.mockResolvedValue(
      profile("second@example.test", "cloud-b"),
    );
    fixtures.session = {
      ...fixtures.session,
      user: { id: "steward-b", email: "unverified-b@example.test" },
    };
    v.rerenderPage();
    await screen.findByText("second@example.test");
    await act(async () => {
      finishA({ json: async () => ({ keyPrefix: "ek_old_account" }) });
    });
    expect(screen.queryByText("Authentication Complete!")).toBeNull();
    expect(screen.getByText("second@example.test")).toBeTruthy();
    expect(fixtures.publish).not.toHaveBeenCalled();
    expect(fixtures.navigate).not.toHaveBeenCalled();
    expect(fixtures.complete).toHaveBeenCalledTimes(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Authorize" }),
    );
    await screen.findByText("Authentication Complete!");
    expect(fixtures.complete).toHaveBeenCalledTimes(2);
    expect(fixtures.publish).toHaveBeenCalledTimes(1);
  });
  it("ignores old completion failure after awaited session cleanup crosses an account switch", async () => {
    let finishCleanup: () => void = () => {};
    fixtures.signOut.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    fixtures.complete.mockRejectedValueOnce(
      new ApiError(401, "unauthorized", "Old session expired"),
    );
    const v = view();
    await screen.findByText("carson@example.test");
    await userEvent.click(
      screen.getByRole("button", { name: "Authorize" }),
    );
    await waitFor(() => expect(fixtures.signOut).toHaveBeenCalledTimes(1));
    fixtures.profile.mockResolvedValue(
      profile("second@example.test", "cloud-b"),
    );
    fixtures.session = {
      ...fixtures.session,
      user: { id: "steward-b", email: "unverified-b@example.test" },
    };
    v.rerenderPage();
    await screen.findByText("second@example.test");
    await act(async () => {
      finishCleanup();
    });
    expect(screen.queryByText("Authentication Error")).toBeNull();
    expect(screen.queryByText("Old session expired")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Authorize" }),
    ).toBeTruthy();
    expect(fixtures.complete).toHaveBeenCalledTimes(1);
    expect(fixtures.publish).not.toHaveBeenCalled();
    expect(fixtures.navigate).not.toHaveBeenCalled();
  });

  it("does not navigate an old account-switch action after another account becomes current", async () => {
    let finishSwitch: () => void = () => {};
    fixtures.signOut.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSwitch = resolve;
        }),
    );
    const v = view();
    await screen.findByText("carson@example.test");
    await userEvent.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );
    await waitFor(() => expect(fixtures.signOut).toHaveBeenCalledTimes(1));
    fixtures.profile.mockResolvedValue(
      profile("second@example.test", "cloud-b"),
    );
    fixtures.session = {
      ...fixtures.session,
      user: { id: "steward-b", email: "unverified-b@example.test" },
    };
    v.rerenderPage();
    await screen.findByText("second@example.test");
    await act(async () => {
      finishSwitch();
    });
    expect(fixtures.navigate).not.toHaveBeenCalled();
    expect(fixtures.complete).not.toHaveBeenCalled();
    expect(fixtures.publish).not.toHaveBeenCalled();
    expect(screen.getByText("second@example.test")).toBeTruthy();
  });

  it("finishes an explicit switch through its own signed-out transition with the same callback", async () => {
    let finishSwitch: () => void = () => {};
    fixtures.signOut.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSwitch = resolve;
        }),
    );
    // A previous automatic-login visit already used the page's anti-loop guard.
    // This prevents an unrelated automatic redirect from masking the switch callback.
    window.sessionStorage.setItem(
      "eliza-cloud-cli-login-autosignin:bbbbbbbb-2222-4333-8444-cccccccccccc",
      "1",
    );
    const v = view();
    await screen.findByText("carson@example.test");
    await userEvent.click(
      screen.getByRole("button", { name: "Use a different account" }),
    );
    await waitFor(() => expect(fixtures.signOut).toHaveBeenCalledTimes(1));
    fixtures.session = { ready: true, authenticated: false, user: null };
    v.rerenderPage();
    expect(fixtures.navigate).not.toHaveBeenCalled();
    await act(async () => {
      finishSwitch();
    });
    await waitFor(() =>
      expect(fixtures.navigate).toHaveBeenCalledWith(
        "/login?returnTo=" +
          encodeURIComponent(
            "/auth/cli-login?session=bbbbbbbb-2222-4333-8444-cccccccccccc",
          ),
        { replace: true },
      ),
    );
    expect(fixtures.complete).not.toHaveBeenCalled();
    expect(fixtures.publish).not.toHaveBeenCalled();
  });

  it.each(["cancel", "unmount", "session", "returnTarget"] as const)(
    "invalidates a pending account switch on %s",
    async (change) => {
      let finishSwitch: () => void = () => {};
      fixtures.signOut.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishSwitch = resolve;
          }),
      );
      const v = view();
      await screen.findByText("carson@example.test");
      await userEvent.click(
        screen.getByRole("button", { name: "Use a different account" }),
      );
      await waitFor(() => expect(fixtures.signOut).toHaveBeenCalledTimes(1));
      if (change === "cancel")
        await userEvent.click(
          screen.getByRole("button", { name: "Cancel" }),
        );
      else if (change === "unmount") v.unmount();
      else {
        if (change === "session")
          fixtures.params.set(
            "session",
            "aaaaaaaa-1111-4222-8333-dddddddddddd",
          );
        else fixtures.params.set("returnTo", "http://localhost:3000/");
        v.rerenderPage();
      }
      await act(async () => {
        finishSwitch();
      });
      expect(fixtures.navigate).not.toHaveBeenCalled();
      expect(fixtures.complete).not.toHaveBeenCalled();
      expect(fixtures.publish).not.toHaveBeenCalled();
    },
  );
});
