// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const bootConfigMock = vi.hoisted(() => ({
  value: {} as { apiBase?: string },
}));

const fetchWithCsrfMock = vi.hoisted(() => ({
  fn: vi.fn(),
}));

vi.mock("../config/boot-config", () => ({
  getBootConfig: () => bootConfigMock.value,
}));

vi.mock("./csrf-client", () => ({
  fetchWithCsrf: fetchWithCsrfMock.fn,
}));

import { fetchSuggestedLanguage } from "./i18n-locale-client";

describe("fetchSuggestedLanguage", () => {
  beforeEach(() => {
    bootConfigMock.value = {};
    fetchWithCsrfMock.fn.mockReset();
  });

  it("skips the cloud-only locale endpoint on local dev origins", async () => {
    await expect(fetchSuggestedLanguage()).resolves.toBeNull();

    expect(window.location.hostname).toMatch(/localhost|127\.0\.0\.1/);
    expect(fetchWithCsrfMock.fn).not.toHaveBeenCalled();
  });

  it("uses an explicit API base even on local origins", async () => {
    bootConfigMock.value = { apiBase: "http://127.0.0.1:31337/" };
    fetchWithCsrfMock.fn.mockResolvedValue(
      new Response(JSON.stringify({ language: "es" }), { status: 200 }),
    );

    await expect(fetchSuggestedLanguage()).resolves.toBe("es");

    expect(fetchWithCsrfMock.fn).toHaveBeenCalledWith(
      "http://127.0.0.1:31337/api/i18n/locale",
    );
  });
});
