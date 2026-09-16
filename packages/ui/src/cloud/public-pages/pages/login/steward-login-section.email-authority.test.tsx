/** Exercises email/SMS attempts and email waiting-tab completion through the real login page, SDK, HTTP helpers and canonical authority. HTTP and the advisory notification bus are isolated; no provider request leaves this fixture. */
// @vitest-environment jsdom

import {
  clearStoredStewardToken,
  getStewardTabSessionAuthorityCoordinator,
  readStoredStewardToken,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({
  listener: null as
    | null
    | ((message: { email: string; destination: string }) => void),
}));
vi.mock("../../lib/steward-email-login-complete", () => ({
  subscribeStewardEmailLoginComplete: (
    _email: string,
    listener: NonNullable<typeof notices.listener>,
  ) => {
    notices.listener = listener;
    return () => {
      notices.listener = null;
    };
  },
}));
vi.mock("../../../shell/CloudI18nProvider", () => {
  const translate = (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key;
  return { useCloudT: () => translate };
});

import StewardLoginSection from "./steward-login-section";

const email = "email-authority@example.com";
const token = `e30.${btoa(JSON.stringify({ email, userId: "email-authority-fixture", tenantId: "elizacloud", exp: 4102444800 }))}.synthetic`;
let consumed: boolean;
let pending: ReturnType<typeof Promise.withResolvers<Response>>;
let refreshRequests: RequestInit[];
let verificationRequests: RequestInit[];
let sendRequests: RequestInit[];
let cloudSyncs: number;
let cloudRequests: RequestInit[];
let delayedSend: ReturnType<typeof Promise.withResolvers<Response>> | null;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  sessionStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
  consumed = false;
  pending = Promise.withResolvers<Response>();
  refreshRequests = [];
  verificationRequests = [];
  sendRequests = [];
  cloudSyncs = 0;
  cloudRequests = [];
  delayedSend = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path.endsWith("/auth/providers"))
        return Response.json({
          passkey: false,
          email: true,
          sms: true,
          siwe: false,
          siws: false,
          google: false,
          discord: false,
          github: false,
          twitter: false,
          oauth: [],
        });
      if (path.endsWith("/tenants/config")) return Response.json({ ok: true });
      if (
        (path.endsWith("/auth/sms/send") ||
          path.endsWith("/auth/email/send")) &&
        init
      ) {
        sendRequests.push(init);
        return (
          delayedSend?.promise ??
          Response.json({
            expiresAt: Date.now() + 600_000,
            challengeId: "fixture-challenge",
            pollSecret: "fixture-poll",
            codeDelivery: "email",
          })
        );
      }
      if (path.endsWith("/auth/email/status"))
        return Response.json({ status: consumed ? "consumed" : "pending" });
      if (path === "/api/auth/steward-refresh" && init) {
        refreshRequests.push(init);
        return pending.promise;
      }
      if (
        (path.endsWith("/auth/email/code/verify") ||
          path.endsWith("/auth/sms/verify")) &&
        init
      ) {
        verificationRequests.push(init);
        return pending.promise;
      }
      if (path === "/api/auth/steward-session" && init) {
        cloudSyncs += 1;
        cloudRequests.push(init);
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected isolated HTTP: ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  pending.resolve(Response.json({ ok: true, token }));
  delayedSend?.resolve(
    Response.json({ expiresAt: Date.now() + 600_000, codeDelivery: "email" }),
  );
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
});
function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="destination">
      {location.pathname + location.search}
    </output>
  );
}
async function begin(
  mode: "poll" | "notice" | "email" | "sms",
  waitForChallenge = true,
) {
  const view = render(
    <MemoryRouter
      initialEntries={["/login?returnTo=%2Fchat%3Fconversation%3Dfixture"]}
    >
      <Routes>
        <Route path="/login" element={<StewardLoginSection />} />
        <Route
          path="*"
          element={<div>Authenticated destination fixture</div>}
        />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
  if (mode === "sms") {
    fireEvent.change(await screen.findByLabelText("Phone number"), {
      target: { value: "+14155552671" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
  } else {
    fireEvent.change(await screen.findByPlaceholderText("you@example.com"), {
      target: { value: email },
    });
    fireEvent.click(screen.getByRole("button", { name: /Magic Link/i }));
  }
  if (!waitForChallenge) {
    await waitFor(() => expect(sendRequests).toHaveLength(1));
    return view;
  }
  await screen.findByLabelText("Six-digit code");
  if (mode === "email" || mode === "sms") return view;
  if (mode === "poll") {
    consumed = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
  } else {
    act(() =>
      notices.listener?.({ email, destination: "/chat?conversation=fixture" }),
    );
  }
  await waitFor(() => expect(refreshRequests).toHaveLength(1));
  return view;
}

describe.each(["email", "sms"] as const)(
  "%s code attempt authority",
  (method) => {
    it.each(["logout", "replacement"])(
      "rejects a code challenge whose delayed send finishes after %s",
      async (winner) => {
        delayedSend = Promise.withResolvers<Response>();
        await begin(method, false);
        if (winner === "logout") await clearStoredStewardToken();
        else localStorage.setItem(STEWARD_TOKEN_KEY, "replacement-fixture");
        await act(async () => {
          delayedSend?.resolve(
            Response.json({
              expiresAt: Date.now() + 600_000,
              codeDelivery: "email",
            }),
          );
        });
        await screen.findByRole("alert");
        expect(screen.queryByLabelText("Six-digit code")).toBeNull();
        expect(cloudSyncs).toBe(0);
        expect(readStoredStewardToken()).toBe(
          winner === "replacement" ? "replacement-fixture" : null,
        );
      },
    );
    const verified = () =>
      Response.json({
        token,
        refreshToken: "synthetic-refresh",
        expiresIn: 3600,
        user: { id: "email-authority-fixture", email },
      });
    function verify() {
      fireEvent.change(screen.getByLabelText("Six-digit code"), {
        target: { value: "123456" },
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: method === "sms" ? "Verify phone" : /Verify code/i,
        }),
      );
    }
    it("keeps uninterrupted code verification and the requested destination working", async () => {
      await begin(method);
      verify();
      await waitFor(() => expect(verificationRequests).toHaveLength(1));
      await act(async () => {
        pending.resolve(verified());
      });
      await waitFor(() =>
        expect(screen.getByTestId("destination").textContent).toBe(
          "/chat?conversation=fixture",
        ),
      );
      expect(readStoredStewardToken()).toBe(token);
      expect(cloudSyncs).toBe(1);
      expect(JSON.parse(String(cloudRequests[0].body))).toEqual({
        token,
        refreshToken: "synthetic-refresh",
        ...(method === "sms" ? { verifiedPhone: "+14155552671" } : {}),
      });
    });
    it("does not verify an old challenge after logout", async () => {
      await begin(method);
      await clearStoredStewardToken();
      verify();
      await act(async () => {
        pending.resolve(verified());
      });
      await screen.findByRole("alert");
      expect(verificationRequests).toHaveLength(0);
      expect(cloudSyncs).toBe(0);
      expect(readStoredStewardToken()).toBeNull();
    });
    it.each(["logout", "replacement", "unmount", "pagehide", "back"])(
      "discards a late code result after %s",
      async (winner) => {
        const view = await begin(method);
        verify();
        await waitFor(() => expect(verificationRequests).toHaveLength(1));
        if (winner === "logout") await clearStoredStewardToken();
        if (winner === "replacement")
          localStorage.setItem(STEWARD_TOKEN_KEY, "replacement-fixture");
        if (winner === "unmount") view.unmount();
        if (winner === "pagehide")
          act(() => window.dispatchEvent(new Event("pagehide")));
        if (winner === "back")
          fireEvent.click(
            screen.getByRole("button", { name: /Back to login/i }),
          );
        await act(async () => {
          pending.resolve(verified());
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(cloudSyncs).toBe(0);
        expect(readStoredStewardToken()).toBe(
          winner === "replacement" ? "replacement-fixture" : null,
        );
        if (winner === "pagehide") {
          pending = Promise.withResolvers<Response>();
          pending.resolve(verified());
          act(() => window.dispatchEvent(new Event("pageshow")));
          fireEvent.click(
            screen.getByRole("button", {
              name: method === "sms" ? "Text me a code" : /Magic Link/i,
            }),
          );
          await screen.findByLabelText("Six-digit code");
          verify();
          await waitFor(() => expect(readStoredStewardToken()).toBe(token));
          expect(cloudSyncs).toBe(1);
        }
      },
    );
  },
);
describe("email challenge replacement", () => {
  it("cancels the old waiting-tab recovery as soon as resend starts", async () => {
    await begin("email");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    act(() =>
      notices.listener?.({ email, destination: "/chat?conversation=fixture" }),
    );
    await waitFor(() => expect(refreshRequests).toHaveLength(1));
    delayedSend = Promise.withResolvers<Response>();
    fireEvent.click(screen.getByRole("button", { name: "Resend email" }));
    expect(refreshRequests[0].signal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(Response.json({ ok: true, token }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(readStoredStewardToken()).toBeNull();
    expect(screen.queryByText("Signed in")).toBeNull();
  });
});

describe.each(["poll", "notice"] as const)(
  "email completion from %s",
  (mode) => {
    it("rejects a challenge logged out before cookie recovery starts", async () => {
      await begin("email");
      await clearStoredStewardToken();
      if (mode === "poll") {
        consumed = true;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3_000);
        });
      } else {
        act(() =>
          notices.listener?.({
            email,
            destination: "/chat?conversation=fixture",
          }),
        );
      }
      await screen.findByRole("alert");
      expect(refreshRequests).toHaveLength(0);
      expect(readStoredStewardToken()).toBeNull();
    });
    it("publishes a verified uninterrupted waiting-tab session", async () => {
      await begin(mode);
      await act(async () => {
        pending.resolve(Response.json({ ok: true, token }));
      });
      await screen.findByText("Signed in");
      expect(readStoredStewardToken()).toBe(token);
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(screen.getByTestId("destination").textContent).toBe(
          "/chat?conversation=fixture",
        ),
      );
    });

    it("rejects Continue after the successfully recovered session is logged out", async () => {
      await begin(mode);
      await act(async () => {
        pending.resolve(Response.json({ ok: true, token }));
      });
      await screen.findByText("Signed in");
      await clearStoredStewardToken();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByRole("alert");
      expect(screen.getByTestId("destination").textContent).toContain(
        "/login?",
      );
      expect(screen.queryByText("Signed in")).toBeNull();
      expect(readStoredStewardToken()).toBeNull();
    });

    it("does not publish after logout wins between the response and waiting-tab commit", async () => {
      await begin(mode);
      const logout = clearStoredStewardToken();
      await act(async () => {
        pending.resolve(Response.json({ ok: true, token }));
        await logout;
      });
      await screen.findByRole("alert");
      expect(screen.queryByText("Signed in")).toBeNull();
      expect(readStoredStewardToken()).toBeNull();
    });

    it("preserves an unrelated account replacement during the refresh", async () => {
      await begin(mode);
      localStorage.setItem(STEWARD_TOKEN_KEY, "replacement-fixture");
      await act(async () => {
        pending.resolve(Response.json({ ok: true, token }));
      });
      await screen.findByRole("alert");
      expect(screen.queryByText("Signed in")).toBeNull();
      expect(readStoredStewardToken()).toBe("replacement-fixture");
    });

    it("cancels a departed waiting tab without a late canonical write", async () => {
      const view = await begin(mode);
      view.unmount();
      expect(refreshRequests[0].signal?.aborted).toBe(true);
      await act(async () => {
        pending.resolve(Response.json({ ok: true, token }));
        await getStewardTabSessionAuthorityCoordinator().runExclusive({
          kind: "session-sync",
          work: async () => {},
        });
      });
      expect(readStoredStewardToken()).toBeNull();
    });
  },
);
