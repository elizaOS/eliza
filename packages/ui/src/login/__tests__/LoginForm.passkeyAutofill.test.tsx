// @vitest-environment jsdom
/**
 * Exercises passkey initiation through mounted React controls and real DOM events.
 * Typing must not start WebAuthn; the explicit button uses the entered account.
 */

import * as React from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, test, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { createRoot } = await import("react-dom/client");

// Spy on navigator.credentials.get so any conditional-mediation request
// issued by the component (mount-time or type-time) is detected.
const credentialsGet = vi.fn(async (..._args: unknown[]) => {
  throw new Error("navigator.credentials.get must not be called by LoginForm");
});
Object.defineProperty(window.navigator, "credentials", {
  value: { get: credentialsGet, create: vi.fn(async () => null) },
  configurable: true,
});

const { LoginForm } = await import("../components/LoginForm.js");
const { LoginAuthContext } = await import("../provider.js");
const { registerEvmWalletPanel, registerSolanaWalletPanel } = await import(
  "../internal/walletPanelRegistry.js"
);

const dummyPanel: React.ComponentType<unknown> = () => null;
registerEvmWalletPanel({ load: async () => ({ default: dummyPanel }) });
registerSolanaWalletPanel({ load: async () => ({ default: dummyPanel }) });

const signInWithPasskey = vi.fn(async (_email: string) => ({}));

function baseCtx() {
  return {
    isAuthenticated: false,
    isLoading: false,
    user: null,
    session: null,
    providers: { google: true },
    isProvidersLoading: false,
    guestState: { isGuest: false, isExpired: false, expiryMessage: null },
    signOut: () => {},
    signInAsGuest: async () => ({}),
    upgradeGuestWithEmail: async () => ({}),
    deleteGuest: async () => ({}),
    getToken: () => null,
    signInWithPasskey,
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
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

async function renderLogin(): Promise<void> {
  if (root) {
    await React.act(async () => root?.unmount());
    root = null;
  }
  container = window.document.createElement("div") as unknown as HTMLDivElement;
  window.document.body.replaceChildren(container as unknown as Node);
  root = createRoot(container);
  await React.act(async () => {
    root?.render(
      React.createElement(
        LoginAuthContext.Provider,
        {
          value: baseCtx() as unknown as React.ContextType<
            typeof LoginAuthContext
          >,
        },
        React.createElement(LoginForm, {}),
      ),
    );
  });
}

function emailInput(): HTMLInputElement {
  const input = container.querySelector('input[aria-label="email"]');
  if (!input) throw new Error("email input not found");
  return input as unknown as HTMLInputElement;
}

async function typeEmail(value: string): Promise<void> {
  const input = emailInput();
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setter) throw new Error("DOM input value setter unavailable");
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  credentialsGet.mockClear();
  signInWithPasskey.mockClear();
  signInWithPasskey.mockImplementation(async () => ({}));
  await renderLogin();
});

describe("passkey conditional-mediation autofill regression", () => {
  test("email input does not carry the webauthn autofill token", () => {
    const attr = (emailInput() as unknown as Element).getAttribute(
      "autocomplete",
    );
    expect(attr).toBe("email");
    expect(attr).not.toContain("webauthn");
  });

  test("no conditional-mediation credentials.get() on mount or while typing a new email", async () => {
    expect(credentialsGet).toHaveBeenCalledTimes(0);
    await typeEmail("brand-new-user@example.com");
    expect(credentialsGet).toHaveBeenCalledTimes(0);
    // No passkey flow started implicitly either.
    expect(signInWithPasskey).toHaveBeenCalledTimes(0);
  });

  test("explicit passkey button still initiates email-scoped passkey login", async () => {
    await typeEmail("brand-new-user@example.com");
    const btn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "passkey",
    );
    if (!btn) throw new Error("passkey button not found");
    await React.act(async () => {
      (btn as unknown as Element).dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }),
      );
    });
    expect(signInWithPasskey).toHaveBeenCalledTimes(1);
    expect(signInWithPasskey).toHaveBeenCalledWith(
      "brand-new-user@example.com",
    );
  });
});
