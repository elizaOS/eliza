/**
 * Managed-host login routing tests use the real SSO hostname predicate to
 * prove dedicated subdomains stay on the local Steward surface instead of
 * entering a bridge that intentionally excludes user-content hosts.
 */
// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://agent-1.cloud.eliza.app/login?intent=launch"}

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const realLocation = window.location;

function setLocation(hostname: string, origin: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, hostname, origin },
  });
}

vi.mock("./steward-login-section", () => ({
  default: () => <div>Steward login options</div>,
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

import { shouldAutoBridgeToSso } from "../../../sso-bridge/sso-bridge";
import LoginPage from "./login-page";

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: realLocation,
  });
});

describe("managed-cloud login routing", () => {
  it("keeps a production dedicated-agent host on local Steward login", async () => {
    expect(shouldAutoBridgeToSso("agent-1.cloud.eliza.app")).toBe(false);
    render(
      <MemoryRouter initialEntries={["/login?intent=launch"]}>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Taking you to Eliza sign in")).toBeNull();
    expect(
      await screen.findByRole("heading", { name: "Sign in to Eliza" }),
    ).toBeTruthy();
  });

  it("keeps a staging dedicated-agent host on local Steward login", async () => {
    setLocation(
      "agent-9.cloud-staging.eliza.app",
      "https://agent-9.cloud-staging.eliza.app",
    );
    expect(shouldAutoBridgeToSso("agent-9.cloud-staging.eliza.app")).toBe(
      false,
    );
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "Sign in to Eliza" }),
    ).toBeTruthy();
  });
});
