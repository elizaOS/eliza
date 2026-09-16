/** Exercises real wallet buttons, the owned login SDK and Cloud session coordination with synthetic wallet-hook and HTTP boundaries. No extension, signature, account or provider request leaves the fixture. */
// @vitest-environment jsdom

import { LoginAuth } from "@elizaos/login";
import {
  clearStoredStewardToken,
  readStoredStewardToken,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  STEWARD_TOKEN_KEY,
  type StewardSessionAuthorityWorkContext,
} from "@elizaos/shared/steward-session-client";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ComponentProps, type ReactNode, StrictMode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wallets = vi.hoisted(() => ({
  connected: false,
  connecting: false,
  modalOpen: false,
  evmAddress: "0x1111111111111111111111111111111111111111" as `0x${string}`,
  solanaKey: { toBase58: () => "11111111111111111111111111111111" },
  open: vi.fn(),
  signEvm: vi.fn(),
  signSolana: vi.fn(),
  connect: vi.fn(),
  mountGate: null as null | {
    blocked: boolean;
    promise: Promise<void>;
    resolve: () => void;
  },
  entered: vi.fn(),
}));
vi.mock("../../../billing/wallet/steward-wallet-providers", () => ({
  StewardWalletProviders: ({ children }: { children: ReactNode }) => {
    wallets.entered();
    if (wallets.mountGate?.blocked) throw wallets.mountGate.promise;
    return children;
  },
}));
vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({
    openConnectModal: wallets.open,
    connectModalOpen: wallets.modalOpen,
  }),
}));
vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    connected: wallets.connected,
    connecting: wallets.connecting,
    publicKey: wallets.connected ? wallets.solanaKey : null,
    signMessage: wallets.signSolana,
    wallet: null,
  }),
}));
vi.mock("@solana/wallet-adapter-react-ui", () => ({
  useWalletModal: () => ({
    visible: wallets.modalOpen,
    setVisible: wallets.open,
  }),
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({
    isConnected: wallets.connected,
    isConnecting: wallets.connecting,
    address: wallets.connected ? wallets.evmAddress : undefined,
  }),
  useConnect: () => ({ connectors: [], connectAsync: wallets.connect }),
  useSignMessage: () => ({ signMessageAsync: wallets.signEvm }),
}));
vi.mock("../../../shell/CloudI18nProvider", () => {
  const translate = (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key;
  return { useCloudT: () => translate };
});

import { syncStewardSessionCookie } from "../../lib/steward-session";
import { createSignInAttempt } from "./sign-in-attempt";
import StewardLoginSection from "./steward-login-section";
import { WalletButtons } from "./wallet-buttons";

const token = `e30.${btoa(JSON.stringify({ userId: "wallet-authority-fixture", tenantId: "elizacloud", exp: 4102444800 }))}.synthetic`;
const verified = () =>
  Response.json({
    token,
    refreshToken: "synthetic-refresh",
    expiresIn: 3600,
    user: { id: "wallet-authority-fixture", email: "" },
  });
let response: ReturnType<typeof Promise.withResolvers<Response>>;
let nonce: ReturnType<typeof Promise.withResolvers<Response>> | null;
let requests: string[];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
  wallets.connected = true;
  wallets.connecting = false;
  wallets.modalOpen = false;
  wallets.mountGate = null;
  wallets.entered.mockReset();
  wallets.open.mockReset();
  wallets.signEvm.mockReset().mockResolvedValue("0xsynthetic-signature");
  wallets.signSolana.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  response = Promise.withResolvers<Response>();
  nonce = null;
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), window.location.origin).pathname;
      requests.push(path);
      if (path.endsWith("/auth/providers"))
        return Response.json({
          email: true,
          sms: false,
          passkey: false,
          telegram: false,
          siwe: true,
          siws: true,
          google: false,
          discord: false,
          github: false,
          twitter: false,
          oauth: [],
        });
      if (path.endsWith("/tenants/config")) return Response.json({ ok: true });
      if (path.endsWith("/auth/email/send"))
        return Response.json({
          expiresAt: Date.now() + 600_000,
          codeDelivery: "email",
        });
      if (path.endsWith("/auth/nonce"))
        return nonce?.promise ?? Response.json({ nonce: "synthetic-nonce" });
      if (path.endsWith("/auth/verify") || path.endsWith("/auth/verify/solana"))
        return response.promise;
      if (path === "/api/auth/steward-session")
        return Response.json({ ok: true });
      throw new Error(`Unexpected isolated HTTP: ${path}`);
    }),
  );
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    nonce?.resolve(Response.json({ nonce: "synthetic-nonce" }));
    response.resolve(verified());
  });
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
});
function begin(
  kind: "ethereum" | "solana",
  options: Partial<ComponentProps<typeof WalletButtons>> = {},
) {
  const privateStorage = new Map<string, string>();
  const auth = new LoginAuth({
    baseUrl: "https://wallet.example.test",
    tenantId: "elizacloud",
    storage: {
      getItem: (key) => privateStorage.get(key) ?? null,
      setItem: (key, value) => privateStorage.set(key, value),
      removeItem: (key) => privateStorage.delete(key),
    },
  });
  const onError = vi.fn();
  const props = {
    auth,
    disabled: false,
    loadingProvider: null,
    siwe: kind === "ethereum",
    siws: kind === "solana",
    onLoadingChange: vi.fn(),
    onError,
    onSuccess: async (
      result: { token: string; refreshToken?: string },
      authority?: StewardSessionAuthorityWorkContext,
    ) =>
      syncStewardSessionCookie(result.token, result.refreshToken, {
        authority,
      }),
    ...options,
  };
  const view = render(<WalletButtons {...props} />);
  const click = () =>
    fireEvent.click(
      screen.getByRole("button", {
        name: kind === "ethereum" ? "EVM wallet" : "Solana wallet",
      }),
    );
  if (!options.autoStart) click();
  return {
    ...view,
    click,
    update: (next: Partial<ComponentProps<typeof WalletButtons>> = {}) =>
      view.rerender(<WalletButtons {...props} {...next} />),
    onError,
    onLoadingChange: props.onLoadingChange,
  };
}
const isVerify = (path: string) =>
  path.endsWith("/auth/verify") || path.endsWith("/auth/verify/solana");

describe.each(["ethereum", "solana"] as const)(
  "%s attempt authority",
  (kind) => {
    it("acknowledges a normal wallet login exactly once", async () => {
      begin(kind);
      await waitFor(() => expect(requests.some(isVerify)).toBe(true));
      await act(async () => {
        response.resolve(verified());
      });
      expect(readStoredStewardToken()).toBe(token);
      expect(
        requests.filter((path) => path === "/api/auth/steward-session"),
      ).toHaveLength(1);
    });
    it.each([
      "logout",
      "replacement",
      "unmount",
      "pagehide",
      "capability withdrawal",
    ])("does not publish a verified result after %s", async (winner) => {
      const view = begin(kind);
      await waitFor(() => expect(requests.some(isVerify)).toBe(true));
      if (winner === "logout") await clearStoredStewardToken();
      if (winner === "replacement")
        localStorage.setItem(STEWARD_TOKEN_KEY, "replacement-fixture");
      if (winner === "unmount") view.unmount();
      if (winner === "pagehide") fireEvent(window, new Event("pagehide"));
      if (winner === "capability withdrawal")
        view.update({ siwe: false, siws: false });
      await act(async () => {
        response.resolve(verified());
      });
      expect(requests).not.toContain("/api/auth/steward-session");
      expect(readStoredStewardToken()).toBe(
        winner === "replacement" ? "replacement-fixture" : null,
      );
    });
    it("does not request a signature after a delayed nonce outlives logout", async () => {
      nonce = Promise.withResolvers<Response>();
      begin(kind);
      await waitFor(() =>
        expect(requests.some((path) => path.endsWith("/auth/nonce"))).toBe(
          true,
        ),
      );
      await clearStoredStewardToken();
      await act(async () => {
        nonce?.resolve(Response.json({ nonce: "synthetic-nonce" }));
        response.resolve(verified());
      });
      expect(wallets.signEvm).not.toHaveBeenCalled();
      expect(wallets.signSolana).not.toHaveBeenCalled();
      expect(requests.some(isVerify)).toBe(false);
    });
    it("does not redeem a signature that finishes after logout", async () => {
      const signature = Promise.withResolvers<string | Uint8Array>();
      const sign = kind === "ethereum" ? wallets.signEvm : wallets.signSolana;
      sign.mockReturnValue(signature.promise);
      begin(kind);
      await waitFor(() => expect(sign).toHaveBeenCalled());
      await clearStoredStewardToken();
      await act(async () => {
        signature.resolve(
          kind === "ethereum"
            ? "0xsynthetic-signature"
            : new Uint8Array([1, 2, 3]),
        );
        response.resolve(verified());
      });
      expect(requests.some(isVerify)).toBe(false);
      expect(readStoredStewardToken()).toBeNull();
    });
    it("preserves an intended delayed modal connection", async () => {
      wallets.connected = false;
      const view = begin(kind);
      await waitFor(() => expect(wallets.open).toHaveBeenCalled());
      wallets.modalOpen = true;
      view.update();
      wallets.connecting = true;
      wallets.modalOpen = false;
      view.update();
      wallets.connecting = false;
      wallets.connected = true;
      view.update();
      await waitFor(() => expect(requests.some(isVerify)).toBe(true));
      await act(async () => {
        response.resolve(verified());
      });
      expect(readStoredStewardToken()).toBe(token);
    });
    it("does not sign on an unrelated connection after the modal was dismissed", async () => {
      wallets.connected = false;
      const view = begin(kind);
      await waitFor(() => expect(wallets.open).toHaveBeenCalled());
      wallets.modalOpen = true;
      view.update();
      wallets.modalOpen = false;
      view.update();
      wallets.connected = true;
      await act(async () => {
        view.update();
        response.resolve(verified());
      });
      expect(requests.some((path) => path.endsWith("/auth/nonce"))).toBe(false);
      expect(readStoredStewardToken()).toBeNull();
      expect(view.onError).toHaveBeenCalled();
      view.click();
      await waitFor(() => expect(readStoredStewardToken()).toBe(token));
    });
    it("retains the original intent across delayed mounting", async () => {
      const initialAttempt = createSignInAttempt();
      await clearStoredStewardToken();
      const view = begin(kind, { autoStart: kind, initialAttempt });
      await waitFor(() => expect(view.onError).toHaveBeenCalled());
      expect(requests.some((path) => path.endsWith("/auth/nonce"))).toBe(false);
      expect(view.onLoadingChange).toHaveBeenLastCalledWith(null);
    });
    it("ignores a cancelled lazy intent without locking the buttons", async () => {
      const initialAttempt = createSignInAttempt();
      initialAttempt.controller.abort();
      const view = begin(kind, { autoStart: kind, initialAttempt });
      await act(async () => {
        response.resolve(verified());
      });
      expect(requests.some((path) => path.endsWith("/auth/nonce"))).toBe(false);
      expect(view.onLoadingChange).not.toHaveBeenCalled();
      view.click();
      await waitFor(() => expect(readStoredStewardToken()).toBe(token));
    });
  },
);

describe("injected Ethereum account requests", () => {
  it("does not request extension access when a cached-account probe outlives logout", async () => {
    wallets.connected = false;
    const accounts = Promise.withResolvers<string[]>();
    const request = vi.fn().mockReturnValue(accounts.promise);
    vi.stubGlobal("ethereum", { request });
    begin("ethereum");
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({ method: "eth_accounts" }),
    );
    await clearStoredStewardToken();
    await act(async () => {
      accounts.resolve([]);
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([]);
  });
  it("completes an explicitly requested injected-wallet signature", async () => {
    wallets.connected = false;
    const request = vi.fn(async ({ method }: { method: string }) =>
      method === "eth_accounts"
        ? []
        : method === "eth_requestAccounts"
          ? [wallets.evmAddress]
          : "0xsynthetic-signature",
    );
    vi.stubGlobal("ethereum", { request });
    begin("ethereum");
    await waitFor(() => expect(requests.some(isVerify)).toBe(true));
    await act(async () => {
      response.resolve(verified());
    });
    expect(readStoredStewardToken()).toBe(token);
    expect(request.mock.calls.map(([call]) => call.method)).toEqual([
      "eth_accounts",
      "eth_requestAccounts",
      "personal_sign",
    ]);
  });
});

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="destination">
      {location.pathname + location.search}
    </output>
  );
}
async function beginPage(kind: "ethereum" | "solana", strict = false) {
  const page = (
    <MemoryRouter
      initialEntries={["/login?returnTo=%2Fchat%3Fconversation%3Dfixture"]}
    >
      <Routes>
        <Route path="/login" element={<StewardLoginSection />} />
        <Route path="*" element={<div>Authenticated fixture</div>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
  const view = render(strict ? <StrictMode>{page}</StrictMode> : page);
  fireEvent.click(
    await screen.findByRole("button", { name: "Continue with a wallet" }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: kind === "ethereum" ? "EVM wallet" : "Solana wallet",
    }),
  );
  return view;
}
describe.each(["ethereum", "solana"] as const)(
  "%s real login-page handoff",
  (kind) => {
    it.each([false, true])(
      "keeps the chat conversation intent through lazy wallet loading (StrictMode=%s)",
      async (strict) => {
        await beginPage(kind, strict);
        await waitFor(() => expect(requests.some(isVerify)).toBe(true));
        await act(async () => {
          response.resolve(verified());
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
      },
    );
    it.each(["logout", "email", "pagehide"])(
      "does not revive a suspended wallet intent after %s",
      async (winner) => {
        const deferred = Promise.withResolvers<void>();
        wallets.mountGate = { ...deferred, blocked: true };
        await beginPage(kind);
        await waitFor(() => expect(wallets.entered).toHaveBeenCalled());
        if (winner === "logout") await clearStoredStewardToken();
        if (winner === "pagehide") fireEvent(window, new Event("pagehide"));
        if (winner === "email") {
          fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
            target: { value: "wallet-authority@example.com" },
          });
          fireEvent.click(screen.getByRole("button", { name: "Magic Link" }));
          await waitFor(() =>
            expect(
              requests.some((path) => path.endsWith("/auth/email/send")),
            ).toBe(true),
          );
          fireEvent.click(
            await screen.findByRole("button", { name: "Back to login" }),
          );
        }
        await act(async () => {
          if (wallets.mountGate) wallets.mountGate.blocked = false;
          deferred.resolve();
          response.resolve(verified());
        });
        expect(requests.some((path) => path.endsWith("/auth/nonce"))).toBe(
          false,
        );
        expect(requests).not.toContain("/api/auth/steward-session");
        expect(readStoredStewardToken()).toBeNull();
      },
    );
  },
);
