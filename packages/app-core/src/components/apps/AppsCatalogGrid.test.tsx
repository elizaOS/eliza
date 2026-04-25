// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryAppInfo } from "../../api";
import { AppsCatalogGrid } from "./AppsCatalogGrid";

vi.mock("../../state", () => ({
  useApp: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./app-identity", () => ({
  AppHero: ({
    app,
    className,
  }: {
    app: Pick<RegistryAppInfo, "name">;
    className?: string;
  }) => <div data-testid={`hero-${app.name}`} className={className} />,
}));

function makeCatalogCandidate(
  name: string,
  category: RegistryAppInfo["category"] = "utility",
): RegistryAppInfo {
  return {
    name,
    displayName: name,
    description: "",
    category,
    launchType: "local",
    launchUrl: null,
    icon: null,
    heroImage: null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: name,
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
  };
}

function getAppCardTestId(appName: string): string {
  return `app-card-${appName.replace(/[^a-z0-9]+/gi, "-")}`;
}

describe("AppsCatalogGrid", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("puts a 1-item starred section before featured and keeps them on the same row", () => {
    render(
      <AppsCatalogGrid
        activeAppNames={new Set()}
        error={null}
        favoriteAppNames={new Set(["custom-star"])}
        loading={false}
        searchQuery=""
        visibleApps={[
          makeCatalogCandidate("@elizaos/app-lifeops"),
          makeCatalogCandidate("@elizaos/app-companion", "game"),
          makeCatalogCandidate("@elizaos/app-defense-of-the-agents", "game"),
          makeCatalogCandidate("@clawville/app-clawville", "game"),
          makeCatalogCandidate("custom-star"),
        ]}
        onLaunch={() => {}}
        onToggleFavorite={() => {}}
      />,
    );

    const firstRow = screen.getByTestId("apps-section-row-0");
    const firstRowSectionIds = Array.from(
      firstRow.querySelectorAll("section[data-testid]"),
    ).map((element) => element.getAttribute("data-testid"));

    expect(firstRowSectionIds).toEqual([
      "apps-section-favorites",
      "apps-section-featured",
    ]);
  });

  it("keeps featured visible without duplicating starred flagship apps", () => {
    render(
      <AppsCatalogGrid
        activeAppNames={new Set()}
        error={null}
        favoriteAppNames={
          new Set([
            "@elizaos/app-lifeops",
            "@elizaos/app-companion",
            "@elizaos/app-defense-of-the-agents",
          ])
        }
        loading={false}
        searchQuery=""
        visibleApps={[
          makeCatalogCandidate("@elizaos/app-lifeops"),
          makeCatalogCandidate("@elizaos/app-companion", "game"),
          makeCatalogCandidate("@elizaos/app-defense-of-the-agents", "game"),
          makeCatalogCandidate("@clawville/app-clawville", "game"),
        ]}
        onLaunch={() => {}}
        onToggleFavorite={() => {}}
      />,
    );

    const firstRow = screen.getByTestId("apps-section-row-0");

    expect(
      firstRow.querySelector('[data-testid="apps-section-favorites"]'),
    ).not.toBeNull();
    expect(
      firstRow.querySelector('[data-testid="apps-section-featured"]'),
    ).not.toBeNull();

    expect(
      within(screen.getByTestId("apps-section-favorites")).getByTestId(
        getAppCardTestId("@elizaos/app-lifeops"),
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("apps-section-featured")).getByTestId(
        getAppCardTestId("@clawville/app-clawville"),
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("apps-section-featured")).queryByTestId(
        getAppCardTestId("@elizaos/app-lifeops"),
      ),
    ).toBeNull();
  });

  it("supports up to five app cards in a single row", () => {
    render(
      <AppsCatalogGrid
        activeAppNames={new Set()}
        error={null}
        favoriteAppNames={new Set()}
        loading={false}
        searchQuery=""
        visibleApps={[
          makeCatalogCandidate("utility-1"),
          makeCatalogCandidate("utility-2"),
          makeCatalogCandidate("utility-3"),
          makeCatalogCandidate("utility-4"),
          makeCatalogCandidate("utility-5"),
        ]}
        onLaunch={() => {}}
        onToggleFavorite={() => {}}
      />,
    );

    const utilitiesSection = screen.getByTestId(
      "apps-section-developerUtilities",
    );
    const utilityRows = utilitiesSection.querySelectorAll(
      ":scope > div.space-y-2 > div",
    );

    expect(utilityRows).toHaveLength(1);
    expect(
      within(utilitiesSection).getByTestId(getAppCardTestId("utility-5")),
    ).toBeTruthy();
  });
});
