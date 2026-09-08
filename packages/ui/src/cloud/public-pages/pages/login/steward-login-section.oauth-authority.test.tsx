/** Exercises the real login page, PKCE storage and session coordinator at OAuth initiation. HTTP, deferred WebCrypto and native-browser launch are isolated boundaries; no provider approval or navigation leaves the fixture. */
// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import {
  clearStoredStewardToken,
  consumeStewardOAuthAttempt,
  peekStewardOAuthState,
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
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ enabled: false, open: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => native.enabled,
    registerPlugin: () => ({}),
  },
  registerPlugin: () => ({}),
}));
vi.mock("../../../../utils/openExternalUrl", () => ({
  openExternalUrl: native.open,
}));
vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: async () => ({
    usable: false,
    reason: "native-without-bridge",
  }),
}));
vi.mock("../../../shell/CloudI18nProvider", () => {
  const translate = (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key;
  return { useCloudT: () => translate };
});

import { consumePendingOAuthReturnTo } from "../../lib/login-return-to";
import StewardLoginSection from "./steward-login-section";

const originalLocation = Object.getOwnPropertyDescriptor(window, "location");
const loginUrl =
  "https://cloud.eliza.app/login?returnTo=%2Fchat%3Fconversation%3Dfixture";
let digestGate: ReturnType<typeof Promise.withResolvers<void>> | null;
let digestCalls: number;
let finishedDigests: number;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
  const url = new URL(loginUrl);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      href: url.href,
      origin: url.origin,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
      hash: "",
    },
  });
  native.enabled = false;
  native.open.mockReset().mockResolvedValue(true);
  digestGate = null;
  digestCalls = 0;
  finishedDigests = 0;
  vi.stubGlobal("crypto", {
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    randomUUID: webcrypto.randomUUID.bind(webcrypto),
    subtle: {
      digest: async (algorithm: string, data: Uint8Array<ArrayBuffer>) => {
        digestCalls++;
        const gate = digestGate;
        if (gate) await gate.promise;
        const digest = await webcrypto.subtle.digest(algorithm, data);
        finishedDigests++;
        return digest;
      },
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      if (path.endsWith("/auth/providers"))
        return Response.json({
          email: true,
          passkey: false,
          sms: false,
          siwe: false,
          siws: false,
          telegram: false,
          google: true,
          discord: true,
          github: true,
          twitter: true,
          oauth: ["google", "discord", "github", "twitter", "apple"],
        });
      if (path.endsWith("/tenants/config")) return Response.json({ ok: true });
      throw new Error(`Unexpected isolated HTTP: ${path}`);
    }),
  );
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    digestGate?.resolve();
  });
  vi.unstubAllGlobals();
  if (originalLocation)
    Object.defineProperty(window, "location", originalLocation);
  localStorage.clear();
  sessionStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
});
async function begin(provider = "Google") {
  const view = render(
    <MemoryRouter
      initialEntries={["/login?returnTo=%2Fchat%3Fconversation%3Dfixture"]}
    >
      <StewardLoginSection />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: provider }));
  return view;
}
describe("hosted OAuth original intent", () => {
  it.each(["Google", "Discord", "GitHub", "X", "Apple"])(
    "preserves a usable PKCE pair and the conversation intent for %s",
    async (provider) => {
      await begin(provider);
      await waitFor(() => expect(window.location.href).not.toBe(loginUrl));
      const destination = new URL(window.location.href);
      expect(destination.searchParams.get("state")).toBe(
        peekStewardOAuthState(),
      );
      const state = destination.searchParams.get("state");
      if (!state) throw new Error("OAuth launch omitted state");
      const attempt = await consumeStewardOAuthAttempt(state);
      const verifier = attempt.codeVerifier;
      expect(verifier).toBeTruthy();
      const digest = await webcrypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier ?? ""),
      );
      expect(destination.searchParams.get("code_challenge")).toBe(
        Buffer.from(digest).toString("base64url"),
      );
      expect(attempt.returnTo).toBe("/chat?conversation=fixture");
      expect(consumePendingOAuthReturnTo()).toBeNull();
      expect(native.open).not.toHaveBeenCalled();
    },
  );
  it.each(["logout", "replacement", "unmount", "pagehide"])(
    "does not launch after delayed PKCE outlives %s",
    async (winner) => {
      digestGate = Promise.withResolvers<void>();
      const view = await begin();
      await waitFor(() => expect(digestCalls).toBe(1));
      if (winner === "logout")
        await act(async () => {
          await clearStoredStewardToken();
        });
      if (winner === "replacement")
        localStorage.setItem(STEWARD_TOKEN_KEY, "replacement-fixture");
      if (winner === "unmount") view.unmount();
      if (winner === "pagehide") fireEvent(window, new Event("pagehide"));
      await act(async () => {
        digestGate?.resolve();
      });
      await waitFor(() => expect(finishedDigests).toBe(1));
      expect(window.location.href).toBe(loginUrl);
      expect(peekStewardOAuthState()).toBeNull();
      expect(consumePendingOAuthReturnTo()).toBeNull();
      if (winner === "logout" || winner === "replacement") {
        expect(screen.getByRole("alert").textContent).toMatch(
          /session changed/i,
        );
        expect(
          screen
            .getByRole("button", { name: "Google" })
            .hasAttribute("disabled"),
        ).toBe(false);
      }
    },
  );
  it("keeps the new provider's PKCE when an abandoned launch settles later", async () => {
    const oldDigest = Promise.withResolvers<void>();
    digestGate = oldDigest;
    await begin();
    await waitFor(() => expect(digestCalls).toBe(1));
    fireEvent(window, new Event("pagehide"));
    const restore = new Event("pageshow");
    Object.defineProperty(restore, "persisted", { value: true });
    fireEvent(window, restore);
    digestGate = null;
    fireEvent.click(await screen.findByRole("button", { name: "GitHub" }));
    await waitFor(() =>
      expect(window.location.href).toContain("/github/authorize"),
    );
    const newUrl = window.location.href;
    const newState = peekStewardOAuthState();
    await act(async () => {
      oldDigest.resolve();
    });
    await waitFor(() => expect(finishedDigests).toBe(2));
    expect(window.location.href).toBe(newUrl);
    expect(peekStewardOAuthState()).toBe(newState);
  });
});
describe("native OAuth launch ownership", () => {
  it("hands off the original conversation intent without creating WebView PKCE", async () => {
    native.enabled = true;
    await begin();
    await waitFor(() => expect(native.open).toHaveBeenCalledTimes(1));
    const handedOff = new URL(native.open.mock.calls[0][0]);
    expect(handedOff.searchParams.get("nativeProvider")).toBe("google");
    expect(handedOff.searchParams.get("returnTo")).toBe(
      "/chat?conversation=fixture",
    );
    expect(peekStewardOAuthState()).toBeNull();
    expect(digestCalls).toBe(0);
  });
  it.each(["rejection", "unavailable"])(
    "does not overwrite a new launch when an old browser-open returns %s",
    async (result) => {
      native.enabled = true;
      const first = Promise.withResolvers<boolean>();
      const second = Promise.withResolvers<boolean>();
      native.open
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      await begin();
      await waitFor(() => expect(native.open).toHaveBeenCalledTimes(1));
      fireEvent(window, new Event("pagehide"));
      const restore = new Event("pageshow");
      Object.defineProperty(restore, "persisted", { value: true });
      fireEvent(window, restore);
      fireEvent.click(await screen.findByRole("button", { name: "GitHub" }));
      await waitFor(() => expect(native.open).toHaveBeenCalledTimes(2));
      await act(async () => {
        if (result === "rejection")
          first.reject(new Error("old launcher failed"));
        else first.resolve(false);
      });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByRole("button", { name: "GitHub" }).hasAttribute("disabled"),
      ).toBe(true);
      await act(async () => {
        second.resolve(true);
      });
      expect(
        screen.getByRole("button", { name: "GitHub" }).hasAttribute("disabled"),
      ).toBe(false);
    },
  );
});
