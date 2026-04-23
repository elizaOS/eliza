// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryAppInfo } from "../../api";

const { useAppMock, clientMock } = vi.hoisted(() => ({
  useAppMock: vi.fn(),
  clientMock: {
    listApps: vi.fn(),
    listCatalogApps: vi.fn(),
    launchApp: vi.fn(),
  },
}));

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

import { AppsSection } from "./AppsSection";

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

function buildUseAppState(overrides?: Record<string, unknown>) {
  return {
    favoriteApps: ["@elizaos/app-lifeops"],
    appRuns: [],
    setTab: vi.fn(),
    setState: vi.fn(),
    setActionNotice: vi.fn(),
    t: (key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? key,
    ...overrides,
  };
}

describe("AppsSection", () => {
  beforeEach(() => {
    useAppMock.mockReset();
    clientMock.listApps.mockReset();
    clientMock.listCatalogApps.mockReset();
    clientMock.launchApp.mockReset();

    useAppMock.mockReturnValue(buildUseAppState());
    clientMock.listApps.mockResolvedValue([]);
    clientMock.listCatalogApps.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a supplied section header action", async () => {
    const onClick = vi.fn();

    render(
      <AppsSection
        headerAction={
          <button type="button" onClick={onClick}>
            Collapse
          </button>
        }
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Collapse" }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it("navigates internal tool apps through setTab instead of relaunching", async () => {
    const setTab = vi.fn();
    useAppMock.mockReturnValue(buildUseAppState({ setTab }));

    render(<AppsSection />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Launch LifeOps" }),
    );

    await waitFor(() => {
      expect(setTab).toHaveBeenCalledWith("lifeops");
    });
    expect(clientMock.launchApp).not.toHaveBeenCalled();
  });

  it("renders hero images for favorited apps when available", async () => {
    useAppMock.mockReturnValue(
      buildUseAppState({ favoriteApps: ["@elizaos/app-companion"] }),
    );
    clientMock.listApps.mockResolvedValue([
      {
        ...makeCatalogCandidate("@elizaos/app-companion", "game"),
        displayName: "Milady Companion",
        icon: "/icons/companion.svg",
        heroImage: "/heroes/companion.png",
      },
    ]);

    const { container } = render(<AppsSection />);

    await waitFor(() => {
      expect(
        container.querySelector('img[src="/heroes/companion.png"]'),
      ).not.toBeNull();
    });
  });
});
