import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

let authed = true;

vi.doMock("../hooks/useAuth.js", () => ({
  useAuth: () => ({
    isAuthenticated: authed,
    isLoading: false,
    user: { id: "user-1", email: "user@example.test" },
    session: { token: "token", address: "", tenantId: "tenant-1" },
    providers: null,
    isProvidersLoading: false,
    getToken: () => "token",
    signOut: () => {},
  }),
}));

vi.doMock("../hooks/useLogin.js", () => ({
  useLogin: () => ({
    client: {
      listUserAccounts: async () => ({
        accounts: [],
        primaryLoginMethods: [
          { provider: "email", providerAccountId: "user@example.test" },
        ],
      }),
      unlinkUserAccount: async () => ({
        deleted: true,
        issuedBefore: Date.now(),
      }),
      sendUserPhoneAccountLinkOtp: async () => ({
        phone: "***0123",
        expiresAt: new Date().toISOString(),
      }),
      verifyUserPhoneAccountLinkOtp: async () => ({
        account: {
          id: "account-1",
          provider: "phone",
          providerAccountId: "phone:hash",
          expiresAt: null,
        },
        isNew: true,
      }),
      createUserEthereumWalletLinkNonce: async () => ({
        nonce: "nonce",
        message: "message",
        expiresIn: 300,
      }),
      linkUserEthereumWallet: async () => ({
        account: {
          id: "account-2",
          provider: "wallet:ethereum",
          providerAccountId: "0x0000000000000000000000000000000000000001",
          expiresAt: null,
        },
        isNew: true,
      }),
      createUserSolanaWalletLinkNonce: async () => ({
        nonce: "nonce",
        message: "message",
        expiresIn: 300,
      }),
      linkUserSolanaWallet: async () => ({
        account: {
          id: "account-3",
          provider: "wallet:solana",
          providerAccountId: "zshVFXnC99G1ijob5dm9xS1hhSsgzC5PbDaLzSXPdct",
          expiresAt: null,
        },
        isNew: true,
      }),
      linkUserOAuthAccount: async () => ({
        account: {
          id: "account-4",
          provider: "github",
          providerAccountId: "octocat",
          expiresAt: null,
        },
        isNew: true,
      }),
      createUserOAuthAccountLinkChallenge: async () => ({
        state: "oauth-state",
        redirectUri: "https://app.example/callback",
        expiresIn: 300,
      }),
      createUserTelegramAccountLinkChallenge: async () => ({
        challengeId: "telegram-challenge",
        expiresIn: 300,
      }),
      linkUserTelegramAccount: async () => ({
        account: {
          id: "account-5",
          provider: "telegram",
          providerAccountId: "12345",
          expiresAt: null,
        },
        isNew: true,
      }),
      createUserFarcasterAccountLinkNonce: async () => ({
        nonce: "farcaster-nonce",
        expiresIn: 300,
      }),
      linkUserFarcasterAccount: async () => ({
        account: {
          id: "account-6",
          provider: "farcaster",
          providerAccountId:
            "address:0x0000000000000000000000000000000000000001",
          expiresAt: null,
        },
        isNew: true,
      }),
    },
  }),
}));

const { LoginLinkedAccounts } = await import(
  "../components/LoginLinkedAccounts.js"
);

function renderOnce(props: Record<string, unknown> = {}): string {
  return renderToString(React.createElement(LoginLinkedAccounts, props));
}

describe("<LoginLinkedAccounts />", () => {
  test("asks signed-out users to authenticate", () => {
    authed = false;
    const html = renderOnce();
    expect(html).toContain("linked accounts");
    expect(html).toContain("Sign in to manage linked accounts");
  });

  test("renders account management sections for signed-in users", () => {
    authed = true;
    const html = renderOnce();
    expect(html).toContain("Review login methods and connected identities");
    expect(html).toContain("primary login methods");
    expect(html).toContain("link phone");
    expect(html).toContain("connected identities");
    expect(html).toContain("refresh");
  });

  test("renders wallet link actions when signer callbacks are provided", () => {
    authed = true;
    const html = renderOnce({
      ethereumWallet: {
        address: "0x0000000000000000000000000000000000000001",
        signMessage: async () => "0xsig",
      },
      solanaWallet: {
        publicKey: "zshVFXnC99G1ijob5dm9xS1hhSsgzC5PbDaLzSXPdct",
        signMessage: async () => "solana-sig",
      },
    });
    expect(html).toContain("link wallet");
    expect(html).toContain("link ethereum");
    expect(html).toContain("link solana");
  });

  test("renders OAuth and social proof link actions when callbacks are provided", () => {
    authed = true;
    const html = renderOnce({
      oauthProviders: ["google", "github"],
      oauthRedirectUri: "https://app.example/callback",
      onOAuthLinkRequest: async () => ({
        code: "oauth-code",
        redirectUri: "https://app.example/callback",
        state: "oauth-state",
        codeVerifier: "verifier",
      }),
      onTelegramLinkRequest: async () => ({ id: 12345, hash: "telegram-hash" }),
      onFarcasterLinkRequest: async (nonce: string) => ({
        message: `farcaster message ${nonce}`,
        signature: "0xsig",
        custodyAddress: "0x0000000000000000000000000000000000000001",
      }),
    });
    expect(html).toContain("link social login");
    expect(html).toContain("link google");
    expect(html).toContain("link github");
    expect(html).toContain("link social proof");
    expect(html).toContain("link telegram");
    expect(html).toContain("link farcaster");
  });
});
