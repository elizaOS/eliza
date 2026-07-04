// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("./ApiKeysSurface", async () => {
  const { useSetPageHeader } =
    await vi.importActual<typeof import("../../cloud-ui")>("../../cloud-ui");
  return {
    ApiKeysSurface: () => {
      useSetPageHeader({ title: "API Keys" });
      return <div>api keys body</div>;
    },
  };
});

import { ApiKeysPage } from "./ApiKeysPage";

describe("ApiKeysPage", () => {
  it("wraps the API keys surface in a page-header provider", () => {
    render(<ApiKeysPage />);
    expect(screen.getByText("api keys body")).toBeTruthy();
  });
});
