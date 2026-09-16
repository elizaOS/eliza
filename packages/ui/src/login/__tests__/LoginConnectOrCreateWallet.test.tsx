/**
 * <LoginConnectOrCreateWallet /> contract coverage.
 *
 * The component is intentionally exported from `@elizaos/ui` so wallet
 * peer dependencies stay out of the root entry point. These tests cover SSR
 * output and the authenticated embedded-wallet fallback without a browser DOM.
 */

import * as React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

let isAuthenticated = true;
const provisionUserWallet = vi.fn(async () => ({
  agentId: "agent_user_123",
  walletAddress: "0xabc0000000000000000000000000000000000def",
}));

vi.doMock("../hooks/useAuth.js", () => ({
  useAuth: () => ({
    isAuthenticated,
    isLoading: false,
    user: isAuthenticated ? { id: "user_123", email: "a@example.com" } : null,
    session: null,
  }),
}));

vi.doMock("../hooks/useLogin.js", () => ({
  useLogin: () => ({
    client: { provisionUserWallet },
    agentId: "agent_root",
    features: {},
    theme: {},
    tenantConfig: null,
    isLoading: false,
    pollInterval: 30000,
  }),
}));

const {
  LoginConnectOrCreateWallet,
  getEmbeddedWalletActionState,
  getEmbeddedWalletDisplayState,
  provisionEmbeddedWalletFallback,
} = await import("../components/LoginConnectOrCreateWallet.js");

function render(props: Record<string, unknown> = {}) {
  return renderToString(React.createElement(LoginConnectOrCreateWallet, props));
}

describe("<LoginConnectOrCreateWallet />", () => {
  beforeEach(() => {
    isAuthenticated = true;
    provisionUserWallet.mockClear();
  });

  test("renders external wallet placeholders and embedded fallback by default", () => {
    const html = render();
    expect(html).toContain("stwd-connect-or-create-wallet");
    expect(html).toContain('data-testid="stwd-connect-or-create-wallet"');
    expect(html).toContain('data-testid="stwd-connect-or-create-embedded"');
    expect(html).toContain("wallet-loading-evm");
    expect(html).toContain("wallet-loading-solana");
    expect(html).toContain("create embedded wallet");
  });

  test("can render embedded fallback without external wallet panels", () => {
    const html = render({ showExternalWallets: false });
    expect(html).toContain("create embedded wallet");
    expect(html).not.toContain("wallet-loading-evm");
    expect(html).not.toContain("wallet-loading-solana");
  });

  test("disables embedded wallet fallback while signed out", () => {
    isAuthenticated = false;
    const html = render({ showExternalWallets: false });
    expect(html).toContain("sign in to create wallet");
    expect(html).toContain("disabled");
    expect(html).toContain('data-stwd-auth-state="signed-out"');
  });

  test("can delegate signed-out embedded wallet clicks to hosted auth", () => {
    isAuthenticated = false;
    const html = render({
      showExternalWallets: false,
      embeddedAuthRequiredLabel: "open hosted login",
      onAuthRequired: () => {},
    });
    expect(html).toContain("open hosted login");
    expect(html).toContain('data-stwd-auth-state="signed-out"');
    expect(html).not.toMatch(/<button[^>]* disabled(?:[= >])/);
  });

  test("embedded fallback calls the authenticated user wallet provision SDK method", async () => {
    const result = await provisionEmbeddedWalletFallback(
      { provisionUserWallet },
      true,
    );
    expect(result.walletAddress).toBe(
      "0xabc0000000000000000000000000000000000def",
    );
    expect(provisionUserWallet).toHaveBeenCalledTimes(1);
  });

  test("embedded fallback refuses unauthenticated provisioning", async () => {
    await expect(
      provisionEmbeddedWalletFallback({ provisionUserWallet }, false),
    ).rejects.toThrow("sign in before creating an embedded wallet");
    expect(provisionUserWallet).not.toHaveBeenCalled();
  });

  test("embedded action state preserves disabled default without hosted auth callback", () => {
    expect(
      getEmbeddedWalletActionState({
        isAuthenticated: false,
        isCreating: false,
        embeddedLabel: "create embedded wallet",
        embeddedBusyLabel: "creating wallet",
        embeddedSignedOutLabel: "sign in to create wallet",
        embeddedAuthRequiredLabel: "open hosted login",
        embeddedReadyLabel: "wallet ready",
        hasAuthRequiredHandler: false,
        hasEmbeddedWallet: false,
      }),
    ).toEqual({
      disabled: true,
      label: "sign in to create wallet",
      requiresAuth: true,
    });
  });

  test("embedded action state enables hosted auth callback while signed out", () => {
    expect(
      getEmbeddedWalletActionState({
        isAuthenticated: false,
        isCreating: false,
        embeddedLabel: "create embedded wallet",
        embeddedBusyLabel: "creating wallet",
        embeddedSignedOutLabel: "sign in to create wallet",
        embeddedAuthRequiredLabel: "open hosted login",
        embeddedReadyLabel: "wallet ready",
        hasAuthRequiredHandler: true,
        hasEmbeddedWallet: false,
      }),
    ).toEqual({
      disabled: false,
      label: "open hosted login",
      requiresAuth: true,
    });
  });

  test("embedded action state disables duplicate provisioning after a wallet is present", () => {
    expect(
      getEmbeddedWalletActionState({
        isAuthenticated: true,
        isCreating: false,
        embeddedLabel: "create embedded wallet",
        embeddedBusyLabel: "creating wallet",
        embeddedSignedOutLabel: "sign in to create wallet",
        embeddedAuthRequiredLabel: "open hosted login",
        embeddedReadyLabel: "wallet ready",
        hasAuthRequiredHandler: true,
        hasEmbeddedWallet: true,
      }),
    ).toEqual({
      disabled: true,
      label: "wallet ready",
      requiresAuth: false,
    });
  });

  test("embedded display state labels created, connected, and restored wallets", () => {
    expect(
      getEmbeddedWalletDisplayState({
        agentId: "agent_user_123",
        walletAddress: "0xabc0000000000000000000000000000000000def",
        walletIndex: 2,
      }),
    ).toEqual({
      state: "created",
      label: "wallet created at wallet index 2",
      walletAddress: "0xabc0000000000000000000000000000000000def",
      walletIndex: 2,
    });

    const connected = getEmbeddedWalletDisplayState({
      agentId: "agent_user_123",
      walletAddress: "0xabc0000000000000000000000000000000000def",
      claimed: true,
    } as never);
    expect(connected?.state).toBe("connected");

    const restored = getEmbeddedWalletDisplayState({
      agentId: "agent_user_123",
      walletAddress: "0xabc0000000000000000000000000000000000def",
      restoredExisting: true,
    } as never);
    expect(restored?.label).toBe("wallet restored");
  });
});
