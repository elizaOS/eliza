/** Verifies the Telegram cloud connector uses the repository brand mark. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key,
}));

vi.mock("./use-connection-status", () => ({
  useConnectionStatus: () => ({
    status: { configured: false, connected: false },
    isLoading: false,
    isError: false,
    errorMessage: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("../lib/api-client", () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { TelegramConnection } from "./telegram-connection";

afterEach(cleanup);

describe("TelegramConnection", () => {
  it("renders the official Telegram brand SVG instead of a generic message icon", () => {
    const { container } = render(<TelegramConnection />);

    expect(screen.getByText("Telegram Bot")).toBeTruthy();
    const brandIcon = container.querySelector(
      'svg[data-brand-icon="telegram"]',
    );
    expect(brandIcon).toBeTruthy();
    expect(brandIcon?.querySelector("path")?.getAttribute("d")).toContain(
      "M11.944 0A12",
    );
  });
});
