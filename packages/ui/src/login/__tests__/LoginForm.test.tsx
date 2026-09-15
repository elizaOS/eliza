/**
 * LoginForm tests: rules-of-hooks regression coverage.
 *
 * Hooks must remain before the early
 * return on `!ctx`. This test locks in the correct structure by mounting
 * the component in each branch (missing auth context, signed-in, and
 * signed-out) and asserting no throw.
 */

import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

const { LoginForm, composeWalletSuccess, composeWalletError } = await import(
  "../components/LoginForm.js"
);
const { LoginAuthContext } = await import("../provider.js");
const {
  registerEvmWalletPanel,
  registerSolanaWalletPanel,
  _resetWalletPanelRegistry,
} = await import("../internal/walletPanelRegistry.js");

// Register dummy panel loaders. The registry isolates root entry from
// wallet peer deps; tests just need a pair of registered loaders so the
// `<LoginForm>` wallet UI gates open. Real loaders live in
// `@elizaos/ui`.
const dummyPanel = ((): React.ComponentType<unknown> => {
  return () => null;
})();
registerEvmWalletPanel({ load: async () => ({ default: dummyPanel }) });
registerSolanaWalletPanel({ load: async () => ({ default: dummyPanel }) });
void _resetWalletPanelRegistry; // silence unused (used in registry-empty tests below)

type AuthCtx = {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: null;
  session: null | { token: string; user: { id: string; email: string } };
  providers: null | {
    google?: boolean;
    discord?: boolean;
    github?: boolean;
    twitter?: boolean;
    telegram?: boolean;
    farcaster?: boolean;
    sms?: boolean;
    whatsapp?: boolean;
    siwe?: boolean;
    siws?: boolean;
  };
  isProvidersLoading: boolean;
  guestState: {
    isGuest: boolean;
    isExpired: boolean;
    expiryMessage: string | null;
  };
  signOut: () => void;
  signInAsGuest: () => Promise<unknown>;
  upgradeGuestWithEmail: (input: unknown) => Promise<unknown>;
  deleteGuest: () => Promise<unknown>;
  getToken: () => null;
  signInWithPasskey: (email: string) => Promise<unknown>;
  signInWithEmail: (email: string) => Promise<unknown>;
  sendSmsOtp: (phone: string) => Promise<unknown>;
  verifySmsOtp: (phone: string, code: string) => Promise<unknown>;
  sendWhatsAppOtp: (phone: string) => Promise<unknown>;
  verifyWhatsAppOtp: (phone: string, code: string) => Promise<unknown>;
  verifyEmailCallback: () => Promise<unknown>;
  signInWithSIWE: () => Promise<unknown>;
  signInWithSolana?: () => Promise<unknown>;
  signInWithOAuth?: (p: string, c?: unknown) => Promise<unknown>;
  signInWithTelegram: (payload: unknown, config?: unknown) => Promise<unknown>;
  signInWithFarcaster: (payload: unknown, config?: unknown) => Promise<unknown>;
  activeTenantId: null;
  tenants: null;
  isTenantsLoading: boolean;
  listTenants: () => Promise<unknown[]>;
  switchTenant: () => Promise<void>;
  joinTenant: () => Promise<void>;
  leaveTenant: () => Promise<void>;
};

function baseCtx(overrides: Partial<AuthCtx> = {}): AuthCtx {
  return {
    isAuthenticated: false,
    isLoading: false,
    user: null,
    session: null,
    providers: {
      google: true,
      discord: true,
      github: true,
      twitter: true,
      siwe: true,
      siws: true,
    },
    isProvidersLoading: false,
    guestState: { isGuest: false, isExpired: false, expiryMessage: null },
    signOut: () => {},
    signInAsGuest: async () => ({}),
    upgradeGuestWithEmail: async () => ({}),
    deleteGuest: async () => ({}),
    getToken: () => null,
    signInWithPasskey: async () => ({}),
    signInWithEmail: async () => ({}),
    sendSmsOtp: async () => ({}),
    verifySmsOtp: async () => ({}),
    sendWhatsAppOtp: async () => ({}),
    verifyWhatsAppOtp: async () => ({}),
    verifyEmailCallback: async () => ({}),
    signInWithSIWE: async () => ({}),
    signInWithSolana: async () => ({}),
    signInWithOAuth: async () => ({}),
    signInWithTelegram: async () => ({}),
    signInWithFarcaster: async () => ({}),
    activeTenantId: null,
    tenants: null,
    isTenantsLoading: false,
    listTenants: async () => [],
    switchTenant: async () => {},
    joinTenant: async () => {},
    leaveTenant: async () => {},
    ...overrides,
  };
}

function wrap(value: AuthCtx | null, node: React.ReactNode) {
  // Cast: provider's context type has the same shape, we just skip the full
  // generic to avoid pulling the 20-field union into every test.
  return React.createElement(
    LoginAuthContext.Provider,
    { value: value as unknown as React.ContextType<typeof LoginAuthContext> },
    node,
  );
}

describe("<LoginForm /> rules-of-hooks branch coverage", () => {
  test("mounts when no auth context is present (renders inline error)", () => {
    // Provider missing → ctx is null → component shows error message.
    // Critically, this path must still call all hooks unconditionally before
    // returning.
    const html = renderToString(wrap(null, React.createElement(LoginForm, {})));
    expect(html).toContain("stwd-login--error");
  });

  test("mounts in signed-out branch", () => {
    const html = renderToString(
      wrap(
        baseCtx({ isAuthenticated: false }),
        React.createElement(LoginForm, { title: "welcome" }),
      ),
    );
    expect(html).toContain("welcome");
    expect(html).toContain("passkey");
  });

  test("guest lifecycle state is available through auth context", () => {
    function Probe() {
      const ctx = React.useContext(LoginAuthContext);
      return React.createElement(
        "p",
        null,
        ctx?.guestState.expiryMessage ?? "missing",
      );
    }
    const html = renderToString(
      wrap(
        baseCtx({
          guestState: {
            isGuest: true,
            isExpired: false,
            expiryMessage:
              "Guest account expires in 3 days. Upgrade to keep your wallet and data.",
          },
        }),
        React.createElement(Probe),
      ),
    );
    expect(html).toContain("Guest account expires in 3 days");
  });

  test("renders default guest sign-in entry while signed out", () => {
    const html = renderToString(
      wrap(
        baseCtx({ isAuthenticated: false }),
        React.createElement(LoginForm, {}),
      ),
    );
    expect(html).toContain('data-testid="stwd-login-guest"');
    expect(html).toContain("continue as guest");
  });

  test("showGuest={false} hides the signed-out guest entry", () => {
    const html = renderToString(
      wrap(
        baseCtx({ isAuthenticated: false }),
        React.createElement(LoginForm, { showGuest: false }),
      ),
    );
    expect(html).not.toContain('data-testid="stwd-login-guest"');
    expect(html).not.toContain("continue as guest");
  });

  test("renders guest lifecycle panel for authenticated guest sessions", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          isAuthenticated: true,
          session: {
            token: "guest-token",
            user: { id: "guest_123", email: "" },
          },
          guestState: {
            isGuest: true,
            isExpired: false,
            expiryMessage:
              "Guest account expires in 3 days. Upgrade to keep your wallet and data.",
          },
        }),
        React.createElement(LoginForm, {}),
      ),
    );
    expect(html).toContain('data-testid="stwd-login-guest-lifecycle"');
    expect(html).toContain("Guest account expires in 3 days");
    expect(html).toContain('aria-label="guest upgrade email"');
    expect(html).toContain('aria-label="guest upgrade token"');
    expect(html).toContain('data-testid="stwd-login-guest-upgrade"');
    expect(html).toContain('data-testid="stwd-login-guest-delete"');
  });

  test("showGuest={false} keeps authenticated guest sessions headless", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          isAuthenticated: true,
          session: {
            token: "guest-token",
            user: { id: "guest_123", email: "" },
          },
          guestState: {
            isGuest: true,
            isExpired: false,
            expiryMessage:
              "Guest account expires in 3 days. Upgrade to keep your wallet and data.",
          },
        }),
        React.createElement(LoginForm, { showGuest: false }),
      ),
    );
    expect(html).toBe("");
  });

  test("renders SMS OTP fields when backend reports sms enabled", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: true,
            discord: true,
            github: true,
            twitter: true,
            sms: true,
          },
        }),
        React.createElement(LoginForm, { title: "welcome" }),
      ),
    );
    expect(html).toContain('aria-label="phone"');
    expect(html).toContain("text me a code");
  });

  test("showSms={false} hides SMS OTP even when backend reports sms enabled", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: true,
            discord: true,
            github: true,
            twitter: true,
            sms: true,
          },
        }),
        React.createElement(LoginForm, { showSms: false }),
      ),
    );
    expect(html).not.toContain('aria-label="phone"');
    expect(html).not.toContain("text me a code");
  });

  test("renders WhatsApp OTP when backend reports whatsapp enabled", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: true,
            discord: true,
            github: true,
            twitter: true,
            whatsapp: true,
          },
        }),
        React.createElement(LoginForm, { showSms: false }),
      ),
    );
    expect(html).toContain('aria-label="phone"');
    expect(html).toContain("WhatsApp code");
    expect(html).toContain("stwd-login__btn--whatsapp");
  });

  test("showWhatsApp={false} hides WhatsApp OTP even when backend enabled it", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: true,
            discord: true,
            github: true,
            twitter: true,
            whatsapp: true,
          },
        }),
        React.createElement(LoginForm, { showWhatsApp: false }),
      ),
    );
    expect(html).not.toContain("stwd-login__btn--whatsapp");
  });

  test("mounts in signed-in branch (renders nothing)", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          isAuthenticated: true,
          session: { token: "t", user: { id: "u", email: "u@x.io" } },
        }),
        React.createElement(LoginForm, {}),
      ),
    );
    // Full signed-in users return null; guest sessions render lifecycle UI.
    expect(html).toBe("");
  });

  test("mounts in loading branch", () => {
    const html = renderToString(
      wrap(baseCtx({ isLoading: true }), React.createElement(LoginForm, {})),
    );
    // Buttons are disabled when isLoading; we just verify no crash.
    expect(html).toContain("stwd-login");
  });

  test("hook order is stable across ctx transitions", () => {
    // Render three different ctx shapes. With the old bug (hooks after
    // early return), the null ctx path would have called fewer hooks than
    // the authed path. Each render is fresh (SSR), but the invariant we
    // care about is that hook calls are unconditional. If they weren't,
    // any of these calls would throw under react-hooks lint or at runtime
    // on a persistent fiber.
    expect(() =>
      renderToString(wrap(null, React.createElement(LoginForm, {}))),
    ).not.toThrow();
    expect(() =>
      renderToString(
        wrap(
          baseCtx({ isAuthenticated: false }),
          React.createElement(LoginForm, {}),
        ),
      ),
    ).not.toThrow();
    expect(() =>
      renderToString(
        wrap(
          baseCtx({
            isAuthenticated: true,
            session: { token: "t", user: { id: "u", email: "u@x.io" } },
          }),
          React.createElement(LoginForm, {}),
        ),
      ),
    ).not.toThrow();
  });
});

describe("<LoginForm /> showWallets prop", () => {
  // The wallet panels (<WalletLogin.EVM>, <WalletLogin.Solana>) are pulled in
  // via dynamic import inside an effect, so they do not appear in SSR output.
  // Instead we assert against the loading-fallback markers (`stwd-login-wallet-evm-loading`
  // / `stwd-login-wallet-sol-loading`) and the wallet container testid
  // (`stwd-login-wallets`). This is enough to verify the gating logic without
  // pulling in jsdom or wagmi/solana mocks (those are exercised by
  // WalletLogin.test.tsx).

  test("showWallets={true} renders both wallet placeholders when providers report siwe + siws", () => {
    const html = renderToString(
      wrap(baseCtx({}), React.createElement(LoginForm, { showWallets: true })),
    );
    expect(html).toContain("stwd-login-wallets");
    expect(html).toContain("stwd-login-wallet-evm-loading");
    expect(html).toContain("stwd-login-wallet-sol-loading");
  });

  test("default (showWallets undefined) renders no wallet buttons", () => {
    const html = renderToString(
      wrap(baseCtx({}), React.createElement(LoginForm, {})),
    );
    expect(html).not.toContain("stwd-login-wallets");
    expect(html).not.toContain("stwd-login-wallet-evm-loading");
    expect(html).not.toContain("stwd-login-wallet-sol-loading");
  });

  test("showWallets={false} renders no wallet buttons", () => {
    const html = renderToString(
      wrap(baseCtx({}), React.createElement(LoginForm, { showWallets: false })),
    );
    expect(html).not.toContain("stwd-login-wallets");
  });

  test("showWallets={{ evm: true }} renders only EVM", () => {
    const html = renderToString(
      wrap(
        baseCtx({}),
        React.createElement(LoginForm, { showWallets: { evm: true } }),
      ),
    );
    expect(html).toContain("stwd-login-wallets");
    expect(html).toContain("stwd-login-wallet-evm-loading");
    expect(html).not.toContain("stwd-login-wallet-sol-loading");
  });

  test("showWallets={{ solana: true }} renders only Solana", () => {
    const html = renderToString(
      wrap(
        baseCtx({}),
        React.createElement(LoginForm, { showWallets: { solana: true } }),
      ),
    );
    expect(html).toContain("stwd-login-wallets");
    expect(html).toContain("stwd-login-wallet-sol-loading");
    expect(html).not.toContain("stwd-login-wallet-evm-loading");
  });

  test("providers.siwe=false hides EVM even when showWallets={true}", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: { google: true, discord: true, siwe: false, siws: true },
        }),
        React.createElement(LoginForm, { showWallets: true }),
      ),
    );
    expect(html).toContain("stwd-login-wallets");
    expect(html).not.toContain("stwd-login-wallet-evm-loading");
    expect(html).toContain("stwd-login-wallet-sol-loading");
  });

  test("providers.siws=false hides Solana even when showWallets={true}", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: { google: true, discord: true, siwe: true, siws: false },
        }),
        React.createElement(LoginForm, { showWallets: true }),
      ),
    );
    expect(html).toContain("stwd-login-wallets");
    expect(html).toContain("stwd-login-wallet-evm-loading");
    expect(html).not.toContain("stwd-login-wallet-sol-loading");
  });

  test("providers === null (initial load / discovery failed) hides wallet buttons", () => {
    const html = renderToString(
      wrap(
        baseCtx({ providers: null }),
        React.createElement(LoginForm, { showWallets: true }),
      ),
    );
    expect(html).not.toContain("stwd-login-wallets");
    expect(html).not.toContain("stwd-login-wallet-evm-loading");
    expect(html).not.toContain("stwd-login-wallet-sol-loading");
  });

  test("empty wallet panel registry hides wallet buttons even when providers report siwe + siws", () => {
    // Reset the registry to simulate a consumer who imported `@elizaos/ui`
    // but not `@elizaos/ui`. Without registered loaders, rendering
    // a wallet button would produce a permanently-disabled placeholder,
    // which is worse than hiding the button.
    _resetWalletPanelRegistry();
    try {
      const html = renderToString(
        wrap(
          baseCtx({}),
          React.createElement(LoginForm, { showWallets: true }),
        ),
      );
      expect(html).not.toContain("stwd-login-wallets");
      expect(html).not.toContain("stwd-login-wallet-evm-loading");
      expect(html).not.toContain("stwd-login-wallet-sol-loading");
    } finally {
      // Restore for subsequent tests.
      registerEvmWalletPanel({ load: async () => ({ default: dummyPanel }) });
      registerSolanaWalletPanel({
        load: async () => ({ default: dummyPanel }),
      });
    }
  });
});

describe("<LoginForm /> OAuth providers (google + discord + github + twitter)", () => {
  test("all four OAuth buttons render when backend reports all four enabled", () => {
    const html = renderToString(
      wrap(baseCtx({}), React.createElement(LoginForm, {})),
    );
    expect(html).toContain("stwd-login__btn--google");
    expect(html).toContain("stwd-login__btn--discord");
    expect(html).toContain("stwd-login__btn--github");
    expect(html).toContain("stwd-login__btn--twitter");
  });

  test("providers.github=false hides GitHub button", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: true,
            discord: true,
            github: false,
            twitter: true,
            siwe: true,
            siws: true,
          },
        }),
        React.createElement(LoginForm, {}),
      ),
    );
    expect(html).not.toContain("stwd-login__btn--github");
    expect(html).toContain("stwd-login__btn--twitter");
  });

  test("providers.twitter=false hides X button", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: true,
            discord: true,
            github: true,
            twitter: false,
            siwe: true,
            siws: true,
          },
        }),
        React.createElement(LoginForm, {}),
      ),
    );
    expect(html).toContain("stwd-login__btn--github");
    expect(html).not.toContain("stwd-login__btn--twitter");
  });

  test("showGithub={false} hides GitHub even if backend enabled it", () => {
    const html = renderToString(
      wrap(baseCtx({}), React.createElement(LoginForm, { showGithub: false })),
    );
    expect(html).not.toContain("stwd-login__btn--github");
  });

  test("showTwitter={false} hides X even if backend enabled it", () => {
    const html = renderToString(
      wrap(baseCtx({}), React.createElement(LoginForm, { showTwitter: false })),
    );
    expect(html).not.toContain("stwd-login__btn--twitter");
  });

  test("all four enabled triggers grid layout class", () => {
    const html = renderToString(
      wrap(baseCtx({}), React.createElement(LoginForm, {})),
    );
    expect(html).toContain("stwd-login__oauth--grid");
  });

  test("three enabled also triggers grid layout class", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: true,
            discord: true,
            github: true,
            twitter: false,
            siwe: true,
            siws: true,
          },
        }),
        React.createElement(LoginForm, {}),
      ),
    );
    expect(html).toContain("stwd-login__oauth--grid");
    expect(html).not.toContain("stwd-login__btn--twitter");
  });

  test("only two enabled stays single-column (no grid class)", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: true,
            discord: true,
            github: false,
            twitter: false,
            siwe: true,
            siws: true,
          },
        }),
        React.createElement(LoginForm, {}),
      ),
    );
    expect(html).toContain("stwd-login__btn--google");
    expect(html).toContain("stwd-login__btn--discord");
    expect(html).not.toContain("stwd-login__oauth--grid");
  });

  test("renders Telegram when backend enables it and a payload callback is configured", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: false,
            discord: false,
            github: false,
            twitter: false,
            telegram: true,
            siwe: true,
            siws: true,
          },
        }),
        React.createElement(LoginForm, {
          getTelegramLoginPayload: () => ({
            id: 424242,
            auth_date: 1_778_200_000,
            hash: "a".repeat(64),
          }),
        }),
      ),
    );
    expect(html).toContain("stwd-login__btn--telegram");
    expect(html).toContain("Telegram");
  });

  test("hides Telegram when no payload callback is configured", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: false,
            discord: false,
            github: false,
            twitter: false,
            telegram: true,
            siwe: true,
            siws: true,
          },
        }),
        React.createElement(LoginForm, {}),
      ),
    );
    expect(html).not.toContain("stwd-login__btn--telegram");
  });

  test("showTelegram={false} hides Telegram even if backend enabled it", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: false,
            discord: false,
            github: false,
            twitter: false,
            telegram: true,
            siwe: true,
            siws: true,
          },
        }),
        React.createElement(LoginForm, {
          showTelegram: false,
          getTelegramLoginPayload: () => ({
            id: 424242,
            auth_date: 1_778_200_000,
            hash: "a".repeat(64),
          }),
        }),
      ),
    );
    expect(html).not.toContain("stwd-login__btn--telegram");
  });

  test("renders Farcaster when backend enables it and a payload callback is configured", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: false,
            discord: false,
            github: false,
            twitter: false,
            farcaster: true,
            siwe: true,
            siws: true,
          },
        }),
        React.createElement(LoginForm, {
          getFarcasterLoginPayload: () => ({
            message: "siwf-message",
            signature: `0x${"a".repeat(130)}`,
            fid: "4242",
          }),
        }),
      ),
    );
    expect(html).toContain("stwd-login__btn--farcaster");
    expect(html).toContain("Farcaster");
  });

  test("hides Farcaster when no payload callback is configured", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: false,
            discord: false,
            github: false,
            twitter: false,
            farcaster: true,
            siwe: true,
            siws: true,
          },
        }),
        React.createElement(LoginForm, {}),
      ),
    );
    expect(html).not.toContain("stwd-login__btn--farcaster");
  });

  test("showFarcaster={false} hides Farcaster even if backend enabled it", () => {
    const html = renderToString(
      wrap(
        baseCtx({
          providers: {
            google: false,
            discord: false,
            github: false,
            twitter: false,
            farcaster: true,
            siwe: true,
            siws: true,
          },
        }),
        React.createElement(LoginForm, {
          showFarcaster: false,
          getFarcasterLoginPayload: () => ({
            message: "siwf-message",
            signature: `0x${"a".repeat(130)}`,
            fid: "4242",
          }),
        }),
      ),
    );
    expect(html).not.toContain("stwd-login__btn--farcaster");
  });
});

describe("<LoginForm /> wallet success/error bubbling", () => {
  // The bubble adapters (`composeWalletSuccess`, `composeWalletError`) are
  // exported precisely so the contract is testable without spinning up
  // wagmi/@solana mocks. They mirror what `<LoginForm>` wires into the
  // panel `onSuccess` / `onError` props verbatim. The full integration is
  // exercised end-to-end in WalletLogin.test.tsx (panel-level).

  test("wallet sign success bubbles to onSuccess as { token, user }", () => {
    const onSuccess = vi.fn();
    const handler = composeWalletSuccess(onSuccess);
    handler(
      {
        token: "jwt-abc",
        refreshToken: "refresh-xyz",
        expiresIn: 900,
        user: { id: "user-1", email: "a@b.io" },
      },
      "evm",
    );
    expect(onSuccess).toHaveBeenCalledWith({
      token: "jwt-abc",
      user: { id: "user-1", email: "a@b.io" },
    });
  });

  test("wallet sign success is a no-op when consumer onSuccess is undefined", () => {
    const handler = composeWalletSuccess(undefined);
    expect(() =>
      handler(
        {
          token: "t",
          refreshToken: "r",
          expiresIn: 900,
          user: { id: "u", email: "u@x.io" },
        },
        "solana",
      ),
    ).not.toThrow();
  });

  test("wallet sign error bubbles to onError", () => {
    let received: Error | null = null;
    const handler = composeWalletError((err) => {
      received = err;
    });
    const boom = new Error("user rejected signature");
    handler(boom, "evm");
    expect(received).toBe(boom);
  });

  test("wallet sign error is a no-op when consumer onError is undefined", () => {
    const handler = composeWalletError(undefined);
    expect(() => handler(new Error("x"), "solana")).not.toThrow();
  });
});
