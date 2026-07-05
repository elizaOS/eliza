// @vitest-environment jsdom

/**
 * ApiKeysPage must NOT mount its own PageHeaderProvider: the surface's
 * useSetPageHeader has to reach the console shell's provider so the top bar
 * shows the title and the header "Create API Key" CTA renders (a local
 * provider is a dead context nothing reads — #13406 audit finding).
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageHeaderProvider, usePageHeader } from "../../cloud-ui";

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

function ShellHeaderProbe() {
  const { pageInfo } = usePageHeader();
  return <div data-testid="shell-title">{pageInfo?.title ?? ""}</div>;
}

describe("ApiKeysPage", () => {
  it("publishes the surface's page header into the OUTER (shell) provider", () => {
    render(
      <PageHeaderProvider>
        <ShellHeaderProbe />
        <ApiKeysPage />
      </PageHeaderProvider>,
    );
    expect(screen.getByText("api keys body")).toBeTruthy();
    expect(screen.getByTestId("shell-title").textContent).toBe("API Keys");
  });
});
