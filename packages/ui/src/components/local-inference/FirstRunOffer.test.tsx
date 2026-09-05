// @vitest-environment jsdom

/**
 * Regression tests for FirstRunOffer publication filtering and unavailable state.
 * Validates that setup recommendations only pick published eligible tiers and
 * render a distinct unavailable state without download buttons when none exist (#30650).
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  CatalogModel,
  HardwareProbe,
} from "../../api/client-local-inference";
import { FirstRunOffer } from "./FirstRunOffer";

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

const appleSilicon24Gb: HardwareProbe = {
  totalRamGb: 24,
  freeRamGb: 16,
  gpu: null,
  cpuCores: 8,
  platform: "darwin",
  arch: "arm64",
  appleSilicon: true,
  recommendedBucket: "mid",
  source: "os-fallback",
};

describe("FirstRunOffer", () => {
  it("recommends the published 4B model and enables download on 24 GB Apple Silicon", () => {
    const catalog: CatalogModel[] = [
      makeCatalogModel("eliza-1-2b", { minRamGb: 4, sizeGb: 1.5 }),
      makeCatalogModel("eliza-1-4b", { minRamGb: 6, sizeGb: 2.5 }),
    ];

    render(
      <FirstRunOffer
        catalog={catalog}
        installed={[]}
        downloads={[]}
        hardware={appleSilicon24Gb}
        onDownload={vi.fn()}
        busy={false}
      />,
    );

    expect(screen.getByText("Local model required")).toBeTruthy();
    expect(
      screen.getByText(
        /Download the default local model \(Eliza-1 4B\) to run chat on this device\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Download default model" }),
    ).toBeTruthy();
  });

  it("shows distinct unavailable state without download button when no models are published", () => {
    render(
      <FirstRunOffer
        catalog={[]}
        installed={[]}
        downloads={[]}
        hardware={appleSilicon24Gb}
        onDownload={vi.fn()}
        busy={false}
      />,
    );

    expect(screen.getByText("Local model required")).toBeTruthy();
    expect(
      screen.getByText("No local chat model is available on this device."),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
