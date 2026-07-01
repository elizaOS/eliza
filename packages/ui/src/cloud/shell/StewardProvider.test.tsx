// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolveBrowserStewardApiUrl = vi.fn(() => "placeholder-steward-url");

vi.mock("./steward-url", () => ({
  resolveBrowserStewardApiUrl: () => resolveBrowserStewardApiUrl(),
}));

vi.mock("./StewardProviderRuntime", () => ({
  default: ({ children }: { children: ReactNode }) => (
    <div data-testid="steward-runtime">{children}</div>
  ),
}));

import { StewardAuthProvider } from "./StewardProvider";

afterEach(() => {
  cleanup();
  resolveBrowserStewardApiUrl.mockReturnValue("placeholder-steward-url");
});

function renderAt(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <StewardAuthProvider>
        <div data-testid="protected-child" />
      </StewardAuthProvider>
    </MemoryRouter>,
  );
}

describe("StewardAuthProvider", () => {
  it("renders a fail-loud auth configuration error on app-auth routes with an invalid Steward URL", () => {
    renderAt("/app-auth/authorize?app_id=app_123");

    expect(
      screen.getByRole("alert", { name: /sign-in temporarily unavailable/i }),
    ).toBeTruthy();
    expect(screen.queryByTestId("protected-child")).toBeNull();
  });

  it("keeps bypassing Steward runtime on routes that do not need auth", () => {
    renderAt("/docs");

    expect(screen.getByTestId("protected-child")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("loads the Steward runtime on app-auth routes with a valid Steward URL", async () => {
    resolveBrowserStewardApiUrl.mockReturnValue(
      "https://api.elizacloud.ai/steward",
    );

    renderAt("/app-auth/authorize?app_id=app_123");

    expect(screen.queryByTestId("protected-child")).toBeNull();
    expect(await screen.findByTestId("steward-runtime")).toBeTruthy();
    expect(screen.getByTestId("protected-child")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
