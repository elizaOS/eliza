// @vitest-environment jsdom

/**
 * Tests for ModelHubView publication filtering:
 * Verifies that pending/unpublished models are excluded from the hub grid,
 * and when no published models exist, the unavailable banner is rendered with no download buttons.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ActiveModelState,
  CatalogModel,
  HardwareProbe,
} from "../../api/client-local-inference";
import { ModelHubView } from "./ModelHubView";

vi.mock("../../hooks/useRenderGuard", () => ({ useRenderGuard: vi.fn() }));
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

const mockHardware: HardwareProbe = {
  platform: "darwin",
  arch: "arm64",
  totalMemoryBytes: 24 * 1024 * 1024 * 1024,
  freeMemoryBytes: 16 * 1024 * 1024 * 1024,
  cpuCores: 8,
};

const mockActive: ActiveModelState = {
  slot: "TEXT_LARGE",
  modelId: null,
  activeState: "idle",
  loadedModel: null,
};

describe("ModelHubView publication filtering", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders unavailable banner and no download buttons when all catalog models are pending", () => {
    const pendingCatalog: CatalogModel[] = [
      {
        id: "eliza-1-9b",
        name: "Eliza 1 9B",
        bucket: "large",
        sizeBytes: 6 * 1024 * 1024 * 1024,
        publishStatus: "pending",
        hiddenFromCatalog: false,
        ggufFile: "eliza-1-9b.gguf",
      } as CatalogModel,
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
      {
        id: "eliza-1-4b",
        name: "Eliza 1 4B",
        bucket: "mid",
        sizeBytes: 3 * 1024 * 1024 * 1024,
        sizeGb: 3.0,
        params: "4B",
        quant: "Q4_K_M",
        publishStatus: "published",
        hiddenFromCatalog: false,
        ggufFile: "eliza-1-4b.gguf",
      } as CatalogModel,
      {
        id: "eliza-1-9b",
        name: "Eliza 1 9B",
        bucket: "large",
        sizeBytes: 6 * 1024 * 1024 * 1024,
        sizeGb: 6.0,
        params: "9B",
        quant: "Q4_K_M",
        publishStatus: "pending",
        hiddenFromCatalog: false,
        ggufFile: "eliza-1-9b.gguf",
      } as CatalogModel,
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
});
