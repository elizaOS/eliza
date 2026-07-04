// @vitest-environment jsdom

/**
 * Render smoke for the standalone Monetization console page — pins the page
 * against "element type is undefined" regressions (React #130) from barrel or
 * lazy-chunk cycles, which minify into a blank page in production.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key,
}));
vi.mock("../lib/use-session-auth", () => ({
  useRequireAuth: () => ({
    ready: true,
    authenticated: true,
    user: { id: "u1", email: "qa@e.test" },
  }),
  useSessionAuth: () => ({
    ready: true,
    authenticated: true,
    user: { id: "u1", email: "qa@e.test" },
  }),
}));

import { MonetizationPage } from "./MonetizationPage";

describe("MonetizationPage", () => {
  afterEach(cleanup);

  it("renders the tabbed Earnings + Affiliates surface without crashing", () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <MonetizationPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("tab", { name: "Earnings" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Affiliates" })).toBeTruthy();
  });
});
