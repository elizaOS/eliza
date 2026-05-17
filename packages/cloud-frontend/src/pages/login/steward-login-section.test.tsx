import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Providers = {
  passkey?: boolean;
  email?: boolean;
  siwe?: boolean;
  siws?: boolean;
  google?: boolean;
  discord?: boolean;
  github?: boolean;
  oauth?: string[];
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  signInWithEmail: vi.fn(),
  signInWithPasskey: vi.fn(),
}));

vi.mock("@stwd/sdk", () => ({
  StewardAuth: class StewardAuth {
    getProviders = mocks.getProviders;
    signInWithEmail = mocks.signInWithEmail;
    signInWithPasskey = mocks.signInWithPasskey;
    getSession() {
      return null;
    }
    refreshSession() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("@elizaos/ui", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => (
    <div role="alert">{children}</div>
  ),
  AlertDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DiscordIcon: ({ className }: { className?: string }) => (
    <span className={className} aria-hidden="true" />
  ),
}));

vi.mock("@elizaos/cloud-shared/lib/steward-url", () => ({
  resolveBrowserStewardApiUrl: () => "https://steward.test",
}));

vi.mock("../../lib/steward-session", () => ({
  syncStewardSessionCookie: vi.fn(),
}));

vi.mock("./steward-wallet-providers", () => ({
  StewardWalletProviders: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("./wallet-buttons", () => ({
  WalletButtons: () => (
    <div>
      <button type="button">Ethereum</button>
      <button type="button">Solana</button>
    </div>
  ),
}));

import StewardLoginSection from "./steward-login-section";

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<StewardLoginSection />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.getProviders.mockReset();
  mocks.signInWithEmail.mockReset();
  mocks.signInWithPasskey.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("StewardLoginSection", () => {
  test("falls back to default options when provider discovery fails", async () => {
    mocks.getProviders.mockRejectedValue(new Error("provider endpoint down"));

    renderLogin();

    expect(await screen.findByPlaceholderText("you@example.com")).toBeVisible();
    expect(screen.getByRole("button", { name: /passkey/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /magic link/i })).toBeVisible();
    expect(screen.getByText(/provider endpoint down/i)).toBeVisible();
  });

  test("hides login options until provider discovery finishes", async () => {
    const providers = deferred<Providers>();
    mocks.getProviders.mockReturnValue(providers.promise);

    renderLogin();

    expect(
      screen.getByLabelText(/loading sign-in options/i),
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("you@example.com")).toBeNull();
    expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /magic link/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /google/i })).toBeNull();

    providers.resolve({
      passkey: true,
      email: true,
      siwe: true,
      siws: true,
      google: true,
      discord: true,
      github: true,
      oauth: [],
    });

    expect(await screen.findByPlaceholderText("you@example.com")).toBeVisible();
    expect(screen.getByRole("button", { name: /passkey/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /magic link/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /google/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /discord/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /github/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /ethereum/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /solana/i })).toBeVisible();
  });
});
