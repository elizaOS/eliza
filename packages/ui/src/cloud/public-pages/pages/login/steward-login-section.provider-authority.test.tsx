/** Exercises the real login page, owned SDK and Cloud session helpers across passkey/Telegram completion. HTTP, physical WebAuthn, device hints and the Telegram widget are isolated synthetic boundaries; no identity or provider mutation occurs. */
// @vitest-environment jsdom

import {
  clearStoredStewardToken,
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

const hints = vi.hoisted(() => ({ has: vi.fn(), remember: vi.fn() }));
const ceremonies = vi.hoisted(() => ({
  authenticate: vi.fn(),
  register: vi.fn(),
}));
vi.mock("./passkey-device-hints", () => ({
  hasPasskeyDeviceHint: hints.has,
  rememberPasskeyDeviceHint: hints.remember,
}));
vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: async () => ({
    usable: true,
    reason: "available",
  }),
}));
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: ceremonies.authenticate,
  startRegistration: ceremonies.register,
}));
vi.mock("./telegram-login-widget", () => ({
  configuredTelegramBotUsername: () => "synthetic_bot",
  TelegramLoginWidget: ({
    onAuth,
  }: {
    onAuth: (payload: {
      id: number;
      first_name: string;
      auth_date: number;
      hash: string;
    }) => Promise<void>;
  }) => (
    <button
      type="button"
      onClick={() =>
        void onAuth({
          id: 42,
          first_name: "Fixture",
          auth_date: 1,
          hash: "synthetic",
        })
      }
    >
      Complete Telegram fixture
    </button>
  ),
}));
vi.mock("../../../shell/CloudI18nProvider", () => {
  const translate = (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key;
  return { useCloudT: () => translate };
});

import StewardLoginSection from "./steward-login-section";

const email = "provider-authority@example.com";
const token = `e30.${btoa(JSON.stringify({ email, userId: "provider-authority-fixture", tenantId: "elizacloud", exp: 4102444800 }))}.synthetic`;
const completed = () =>
  Response.json({
    token,
    refreshToken: "synthetic-refresh",
    expiresIn: 3600,
    user: { id: "provider-authority-fixture", email },
  });
let pending: ReturnType<typeof Promise.withResolvers<Response>>;
let grant: ReturnType<typeof Promise.withResolvers<Response>> | null;
let passkeyOptions: ReturnType<typeof Promise.withResolvers<Response>> | null;
let ceremony: ReturnType<typeof Promise.withResolvers<{ id: string }>> | null;
let requests: string[];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
  pending = Promise.withResolvers<Response>();
  grant = null;
  passkeyOptions = null;
  ceremony = null;
  ceremonies.authenticate
    .mockReset()
    .mockImplementation(
      () =>
        ceremony?.promise ?? Promise.resolve({ id: "synthetic-credential" }),
    );
  ceremonies.register
    .mockReset()
    .mockImplementation(
      () =>
        ceremony?.promise ??
        Promise.resolve({ id: "synthetic-new-credential" }),
    );
  requests = [];
  hints.has.mockReset().mockResolvedValue(true);
  hints.remember.mockReset().mockResolvedValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      requests.push(path);
      if (path.endsWith("/auth/providers"))
        return Response.json({
          passkey: true,
          telegram: true,
          email: true,
          sms: false,
          siwe: false,
          siws: false,
          google: false,
          discord: false,
          github: false,
          twitter: false,
          oauth: [],
        });
      if (path.endsWith("/tenants/config")) return Response.json({ ok: true });
      if (path.endsWith("/auth/email/otp/send"))
        return Response.json({
          ok: true,
          data: { expiresAt: "2100-01-01T00:00:00Z" },
        });
      if (path.endsWith("/auth/email/otp/verify"))
        return (
          grant?.promise ??
          Response.json({
            ok: true,
            data: { emailGrant: "synthetic-grant", expiresInSeconds: 300 },
          })
        );
      if (
        path.endsWith("/auth/passkey/login/options") ||
        path.endsWith("/auth/passkey/register/options")
      )
        return (
          passkeyOptions?.promise ??
          Response.json({ challengeId: "synthetic-challenge" })
        );
      if (path.endsWith("/auth/telegram/challenge"))
        return Response.json({ challengeId: "synthetic-challenge" });
      if (
        path.endsWith("/auth/passkey/login/verify") ||
        path.endsWith("/auth/passkey/register/verify") ||
        path.endsWith("/auth/telegram/verify")
      )
        return pending.promise;
      if (path === "/api/auth/steward-session")
        return Response.json({ ok: true });
      throw new Error(`Unexpected isolated HTTP: ${path}`);
    }),
  );
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    pending.resolve(completed());
    passkeyOptions?.resolve(
      Response.json({ challengeId: "synthetic-challenge" }),
    );
    ceremony?.resolve({ id: "synthetic-credential" });
    grant?.resolve(
      Response.json({ ok: true, data: { emailGrant: "synthetic-grant" } }),
    );
  });
  vi.unstubAllGlobals();
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

describe.each(["passkey", "enroll"] as const)(
  "%s SDK dispatch lifetime",
  (method) => {
    it.each(
      ["options", "ceremony"].flatMap((phase) =>
        ["logout", "replacement", "unmount", "pagehide", "uninterrupted"].map(
          (end) => ({ phase, end }),
        ),
      ),
    )(
      "gates later dispatch after $phase settles following $end",
      async ({ phase, end }) => {
        const path = `/auth/passkey/${method === "enroll" ? "register" : "login"}`;
        const prompt =
          method === "enroll" ? ceremonies.register : ceremonies.authenticate;
        if (phase === "options")
          passkeyOptions = Promise.withResolvers<Response>();
        else ceremony = Promise.withResolvers<{ id: string }>();
        const view = await begin(method);
        await waitFor(() =>
          expect(requests.some((url) => url.endsWith(`${path}/options`))).toBe(
            true,
          ),
        );
        if (phase === "ceremony")
          await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
        if (end === "logout") await clearStoredStewardToken();
        if (end === "replacement")
          localStorage.setItem(STEWARD_TOKEN_KEY, "replacement-fixture");
        if (end === "unmount") view.unmount();
        if (end === "pagehide") fireEvent(window, new Event("pagehide"));
        await act(async () => {
          passkeyOptions?.resolve(
            Response.json({ challengeId: "synthetic-challenge" }),
          );
          ceremony?.resolve({ id: "synthetic-credential" });
          pending.resolve(completed());
        });
        if (end === "uninterrupted") {
          await waitFor(() =>
            expect(screen.getByTestId("destination").textContent).toBe(
              "/chat?conversation=fixture",
            ),
          );
          expect(prompt).toHaveBeenCalledOnce();
          expect(readStoredStewardToken()).toBe(token);
        } else {
          if (phase === "options") expect(prompt).not.toHaveBeenCalled();
          expect(requests.some((url) => url.endsWith(`${path}/verify`))).toBe(
            false,
          );
          expect(requests).not.toContain("/api/auth/steward-session");
          expect(readStoredStewardToken()).toBe(
            end === "replacement" ? "replacement-fixture" : null,
          );
          expect(hints.remember).not.toHaveBeenCalled();
          if (end === "pagehide") {
            passkeyOptions = null;
            ceremony = null;
            pending = Promise.withResolvers<Response>();
            pending.resolve(completed());
            fireEvent(window, new Event("pageshow"));
            // A fresh click remains usable after a cached page returns; the old
            // credential grant is not silently resumed.
            if (method === "enroll") {
              expect(screen.queryByPlaceholderText("123456")).toBeNull();
              expect(
                screen.queryByRole("button", { name: "Create passkey" }),
              ).toBeNull();
            }
            fireEvent.click(screen.getByRole("button", { name: "Passkey" }));
            if (method === "enroll") {
              fireEvent.change(await screen.findByPlaceholderText("123456"), {
                target: { value: "123456" },
              });
              fireEvent.click(
                screen.getByRole("button", { name: "Create passkey" }),
              );
            }
            await waitFor(() =>
              expect(screen.getByTestId("destination").textContent).toBe(
                "/chat?conversation=fixture",
              ),
            );
          }
        }
      },
    );
  },
);
async function begin(
  method: "passkey" | "telegram" | "enroll",
  completeWidget = true,
) {
  const view = render(
    <MemoryRouter
      initialEntries={["/login?returnTo=%2Fchat%3Fconversation%3Dfixture"]}
    >
      <Routes>
        <Route path="/login" element={<StewardLoginSection />} />
        <Route path="*" element={<div>Authenticated fixture</div>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
  if (method === "telegram") {
    fireEvent.click(await screen.findByRole("button", { name: "Telegram" }));
    if (completeWidget)
      fireEvent.click(
        screen.getByRole("button", { name: "Complete Telegram fixture" }),
      );
  } else {
    fireEvent.change(await screen.findByPlaceholderText("you@example.com"), {
      target: { value: email },
    });
    if (method === "enroll") hints.has.mockResolvedValue(false);
    fireEvent.click(await screen.findByRole("button", { name: "Passkey" }));
    if (method === "enroll") {
      fireEvent.change(await screen.findByPlaceholderText("123456"), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));
    }
  }
  return view;
}

it.each(["logout", "unmount"])(
  "does not start a ceremony when the device hint finishes after %s",
  async (winner) => {
    const hint = Promise.withResolvers<boolean>();
    hints.has.mockReturnValue(hint.promise);
    const view = await begin("passkey");
    await waitFor(() => expect(hints.has).toHaveBeenCalled());
    if (winner === "logout") await clearStoredStewardToken();
    else view.unmount();
    await act(async () => {
      hint.resolve(true);
    });
    expect(
      requests.some((path) => path.endsWith("/auth/passkey/login/options")),
    ).toBe(false);
    expect(requests.some((path) => path.endsWith("/auth/email/otp/send"))).toBe(
      false,
    );
  },
);

it("does not exchange a Telegram payload for a logged-out widget intent", async () => {
  await begin("telegram", false);
  await clearStoredStewardToken();
  fireEvent.click(
    screen.getByRole("button", { name: "Complete Telegram fixture" }),
  );
  await screen.findByRole("alert");
  expect(
    requests.some((path) => path.endsWith("/auth/telegram/challenge")),
  ).toBe(false);
  expect(requests).not.toContain("/api/auth/steward-session");
});

describe.each(["passkey", "telegram", "enroll"] as const)(
  "%s original attempt",
  (method) => {
    const endpoint =
      method === "telegram"
        ? "/auth/telegram/verify"
        : `/auth/passkey/${method === "enroll" ? "register" : "login"}/verify`;
    it("acknowledges the uninterrupted session and preserves conversation intent", async () => {
      await begin(method);
      await waitFor(() =>
        expect(requests.some((path) => path.endsWith(endpoint))).toBe(true),
      );
      await act(async () => {
        pending.resolve(completed());
      });
      await waitFor(() =>
        expect(screen.getByTestId("destination").textContent).toBe(
          "/chat?conversation=fixture",
        ),
      );
      expect(readStoredStewardToken()).toBe(token);
      expect(
        requests.filter((path) => path === "/api/auth/steward-session"),
      ).toHaveLength(1);
    });
    it.each(["logout", "replacement", "unmount", "pagehide"])(
      "rejects a late verified result after %s",
      async (winner) => {
        const view = await begin(method);
        await waitFor(() =>
          expect(requests.some((path) => path.endsWith(endpoint))).toBe(true),
        );
        if (winner === "logout") await clearStoredStewardToken();
        if (winner === "replacement")
          localStorage.setItem(STEWARD_TOKEN_KEY, "replacement-fixture");
        if (winner === "unmount") view.unmount();
        if (winner === "pagehide")
          act(() => window.dispatchEvent(new Event("pagehide")));
        await act(async () => {
          pending.resolve(completed());
        });
        expect(requests).not.toContain("/api/auth/steward-session");
        expect(readStoredStewardToken()).toBe(
          winner === "replacement" ? "replacement-fixture" : null,
        );
        expect(hints.remember).not.toHaveBeenCalled();
        if (winner === "pagehide" && method === "telegram") {
          pending = Promise.withResolvers<Response>();
          pending.resolve(completed());
          act(() => window.dispatchEvent(new Event("pageshow")));
          fireEvent.click(screen.getByRole("button", { name: "Telegram" }));
          fireEvent.click(
            await screen.findByRole("button", {
              name: "Complete Telegram fixture",
            }),
          );
          await waitFor(() => expect(readStoredStewardToken()).toBe(token));
          expect(
            requests.filter((path) => path === "/api/auth/steward-session"),
          ).toHaveLength(1);
        }
      },
    );
  },
);

it.each(["logout", "back", "unmount"])(
  "does not begin passkey creation when the email grant arrives after %s",
  async (winner) => {
    grant = Promise.withResolvers<Response>();
    const view = await begin("enroll");
    await waitFor(() =>
      expect(
        requests.some((path) => path.endsWith("/auth/email/otp/verify")),
      ).toBe(true),
    );
    if (winner === "logout") await clearStoredStewardToken();
    if (winner === "back")
      fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    if (winner === "unmount") view.unmount();
    await act(async () => {
      grant?.resolve(
        Response.json({ ok: true, data: { emailGrant: "synthetic-grant" } }),
      );
      pending.resolve(completed());
    });
    expect(
      requests.some((path) => path.endsWith("/auth/passkey/register/options")),
    ).toBe(false);
    expect(requests).not.toContain("/api/auth/steward-session");
    expect(readStoredStewardToken()).toBeNull();
  },
);
