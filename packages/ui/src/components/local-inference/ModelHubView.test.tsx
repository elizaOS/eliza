// @vitest-environment jsdom

/**
 * Tests for ModelHubView publication filtering:
 * Verifies that pending/unpublished models are excluded from the hub grid when uninstalled,
 * that an unavailable banner is rendered when no published/installed models exist,
 * and that already-installed or actively downloading pending models retain their management rows and actions (#30650).
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ActiveModelState,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
} from "../../api/client-local-inference";
import { ModelHubView } from "./ModelHubView";

vi.mock("../../hooks/useRenderGuard", () => ({ useRenderGuard: vi.fn() }));
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

function makeCatalogModel(
  id: string,
  overrides?: Partial<CatalogModel>,
): CatalogModel {
  return {
    id,
    displayName: `Eliza-1 ${id.replace("eliza-1-", "").toUpperCase()}`,
    hfRepo: "elizaos/eliza-1",
    ggufFile: `${id}.gguf`,
    params: "4B",
    quant: "Q4_K_M",
    sizeGb: 2.5,
    minRamGb: 6,
    category: "chat",
    bucket: "small",
    blurb: `Model ${id}`,
    hiddenFromCatalog: false,
    ...overrides,
  };
}

const mockHardware: HardwareProbe = {
  platform: "darwin",
  arch: "arm64",
  totalRamGb: 24,
  freeRamGb: 16,
  gpu: null,
  cpuCores: 8,
  appleSilicon: true,
  recommendedBucket: "mid",
  source: "os-fallback",
};

const mockActive: ActiveModelState = {
  modelId: null,
  loadedAt: null,
  status: "idle",
};

describe("ModelHubView publication filtering", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders unavailable banner and no download buttons when all catalog models are pending and uninstalled", () => {
    const pendingCatalog: CatalogModel[] = [
      makeCatalogModel("eliza-1-9b", {
        bucket: "large",
        publishStatus: "pending",
      }),
    ];

    render(
      <ModelHubView
        catalog={pendingCatalog}
        installed={[]}
        downloads={[]}
        active={mockActive}
        hardware={mockHardware}
        onDownload={vi.fn()}
        onCancel={vi.fn()}
        onActivate={vi.fn()}
        onUninstall={vi.fn()}
        busy={false}
      />,
    );

    const banner = screen.getByTestId("model-hub-unavailable");
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain(
      "No published models are currently available.",
    );
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
  });

  it("renders model rows with download button when published models exist", () => {
    const mixedCatalog: CatalogModel[] = [
      makeCatalogModel("eliza-1-4b", {
        bucket: "mid",
        publishStatus: "published",
      }),
      makeCatalogModel("eliza-1-9b", {
        bucket: "large",
        publishStatus: "pending",
      }),
    ];

    render(
      <ModelHubView
        catalog={mixedCatalog}
        installed={[]}
        downloads={[]}
        active={mockActive}
        hardware={mockHardware}
        onDownload={vi.fn()}
        onCancel={vi.fn()}
        onActivate={vi.fn()}
        onUninstall={vi.fn()}
        busy={false}
      />,
    );

    expect(screen.queryByTestId("model-hub-unavailable")).toBeNull();
    const downloadButtons = screen.getAllByRole("button", {
      name: /download/i,
    });
    expect(downloadButtons.length).toBe(1);
  });

  it("preserves model row and uninstall control for already-installed pending model", () => {
    const onUninstall = vi.fn();
    const pendingCatalog: CatalogModel[] = [
      makeCatalogModel("eliza-1-9b", {
        bucket: "large",
        publishStatus: "pending",
      }),
    ];
    const installed: InstalledModel[] = [
      {
        id: "eliza-1-9b",
        displayName: "Eliza-1 9B",
        path: "/models/eliza-1-9b.gguf",
        sizeBytes: 6 * 1024 * 1024 * 1024,
        installedAt: "2026-08-28T00:00:00.000Z",
        lastUsedAt: null,
        source: "eliza-download",
      },
    ];

    render(
      <ModelHubView
        catalog={pendingCatalog}
        installed={installed}
        downloads={[]}
        active={mockActive}
        hardware={mockHardware}
        onDownload={vi.fn()}
        onCancel={vi.fn()}
        onActivate={vi.fn()}
        onUninstall={onUninstall}
        busy={false}
      />,
    );

    expect(screen.queryByTestId("model-hub-unavailable")).toBeNull();
    const uninstallButton = screen.getByRole("button", { name: /uninstall/i });
    expect(uninstallButton).not.toBeNull();

    uninstallButton.click();
    expect(onUninstall).toHaveBeenCalledWith("eliza-1-9b");
  });

  it("preserves model row and cancel control for downloading pending model", () => {
    const onCancel = vi.fn();
    const pendingCatalog: CatalogModel[] = [
      makeCatalogModel("eliza-1-9b", {
        bucket: "large",
        publishStatus: "pending",
      }),
    ];
    const downloads: DownloadJob[] = [
      {
        jobId: "job-1",
        modelId: "eliza-1-9b",
        state: "downloading",
        received: 1024 * 1024 * 500,
        total: 1024 * 1024 * 1024 * 6,
        bytesPerSec: 1024 * 1024 * 10,
        etaMs: 60000,
        startedAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:10.000Z",
      },
    ];

    render(
      <ModelHubView
        catalog={pendingCatalog}
        installed={[]}
        downloads={downloads}
        active={mockActive}
        hardware={mockHardware}
        onDownload={vi.fn()}
        onCancel={onCancel}
        onActivate={vi.fn()}
        onUninstall={vi.fn()}
        busy={false}
      />,
    );

    expect(screen.queryByTestId("model-hub-unavailable")).toBeNull();
    const cancelButton = screen.getByRole("button", { name: /cancel/i });
    expect(cancelButton).not.toBeNull();

    cancelButton.click();
    expect(onCancel).toHaveBeenCalledWith("eliza-1-9b");
  });
});
