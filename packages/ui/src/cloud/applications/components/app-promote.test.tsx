// @vitest-environment jsdom

/**
 * `AppPromote` asset-generation error surfacing (#9323): a failed
 * `/promote/assets` call surfaces the error to the user (no silent swallow),
 * and a successful generation shows none. The api-client, router, i18n
 * provider, and promote-dialog are doubled; the component renders for real.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// --- collaborator doubles (hoisted so vi.mock factories can close over them) ---
const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api-client")>(
    "../../lib/api-client",
  );
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});
vi.mock("react-router-dom", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));
vi.mock("../../shell/CloudI18nProvider", () => ({
  // t() returns the provided defaultValue so assertions read real copy.
  useCloudT: () => (_k: string, o?: { defaultValue?: string }) =>
    o?.defaultValue ?? _k,
}));
vi.mock("../../../cloud-ui/components/promotion/promote-app-dialog", () => ({
  PromoteAppDialog: () => null,
}));

import { ApiError } from "../../lib/api-client";
import { AppPromote } from "./app-promote";

const app = { id: "app_1", name: "Test App" } as never;

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("AppPromote — asset generation error surfacing (#9323)", () => {
  it("surfaces the error (no silent swallow) when /promote/assets fails", async () => {
    // Initial load (promote + advertising/accounts) resolves; the assets POST rejects.
    apiMock.mockImplementation((path: string, opts?: { method?: string }) => {
      if (opts?.method === "POST" && path.endsWith("/promote/assets")) {
        return Promise.reject(
          new ApiError(
            402,
            "INSUFFICIENT_CREDITS",
            "Insufficient credits to generate assets",
          ),
        );
      }
      if (path.endsWith("/advertising/accounts")) {
        return Promise.resolve({ accounts: [] });
      }
      // /api/v1/apps/:id/promote -> PromotionSuggestions
      return Promise.resolve({
        recommendedChannels: [],
        estimatedBudget: { min: 0, max: 0 },
        suggestedPlatforms: [],
        tips: [],
      });
    });

    render(<AppPromote app={app} />);

    const button = await screen.findByRole("button", {
      name: /Generate Assets/i,
    });
    await userEvent.click(button);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Insufficient credits to generate assets",
    );
  });

  it("does not show an error on a successful generation", async () => {
    apiMock.mockResolvedValue({
      recommendedChannels: [],
      estimatedBudget: { min: 0, max: 0 },
      suggestedPlatforms: [],
      tips: [],
      accounts: [],
    });
    render(<AppPromote app={app} />);
    const button = await screen.findByRole("button", {
      name: /Generate Assets/i,
    });
    await userEvent.click(button);
    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
