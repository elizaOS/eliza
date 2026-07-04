// @vitest-environment jsdom

/**
 * `AppAuthAuthorizePage` mounts `AuthorizeContent` inside `StewardAuthProvider`
 * so `useAuth()` resolves on this public route (#9881). The provider,
 * authorize-content, i18n provider, and page-title hook are doubled to isolate
 * the wiring.
 */

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// --- collaborator doubles ---

// The real StewardAuthProvider lazy-loads the heavy `@stwd/*` runtime and reads
// router/location context. Stub it with a marker wrapper so we can assert the
// authorize content is mounted INSIDE it (the #9881 fix: useAuth() needs the
// Steward provider as an ancestor on this public route).
vi.mock("../../../shell/StewardProvider", () => ({
  StewardAuthProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="steward-auth-provider">{children}</div>
  ),
}));

vi.mock("../../../../cloud-ui/components/auth/authorize-content", () => ({
  AuthorizeContent: () => <div data-testid="authorize-content" />,
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

import AppAuthAuthorizePage from "./app-authorize-page";

afterEach(() => {
  cleanup();
});

describe("AppAuthAuthorizePage", () => {
  it("mounts AuthorizeContent inside StewardAuthProvider so useAuth() resolves on the public route (#9881)", () => {
    render(<AppAuthAuthorizePage />);

    const provider = screen.getByTestId("steward-auth-provider");
    const content = screen.getByTestId("authorize-content");
    expect(provider).toBeTruthy();
    expect(content).toBeTruthy();
    // The provider must be an ancestor of the authorize content, otherwise
    // `useAuth()` throws "must be used within a <StewardProvider>".
    expect(provider.contains(content)).toBe(true);
  });
});
