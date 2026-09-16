/** Exercises the rendered Settings download action against real catalog publication and hardware policy. */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MODEL_CATALOG } from "../../services/local-inference/catalog";
import { filterSettingsDefaultLocalModels } from "../../services/local-inference/catalog-policy";
import { localInferenceService } from "../../services/local-inference/service";
import type { HardwareProbe } from "../../services/local-inference/types";
import { FirstRunOffer } from "./FirstRunOffer";

const hardware: HardwareProbe = {
  totalRamGb: 24,
  freeRamGb: 16,
  gpu: { backend: "metal", totalVramGb: 24, freeVramGb: 16 },
  cpuCores: 18,
  platform: "darwin",
  arch: "arm64",
  appleSilicon: true,
  recommendedBucket: "large",
  source: "os-fallback",
};

afterEach(cleanup);

it("dispatches a published download even when a larger pending tier fits the Mac", () => {
  const onDownload = vi.fn();
  render(
    <FirstRunOffer
      catalog={localInferenceService.getCatalog()}
      installed={[]}
      downloads={[]}
      hardware={hardware}
      onDownload={onDownload}
      busy={false}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Download default model" }),
  );
  expect(onDownload).toHaveBeenCalledOnce();
  const selected = MODEL_CATALOG.find(
    (model) => model.id === onDownload.mock.calls[0]?.[0],
  );
  expect(selected?.publishStatus).toBe("published");
});

it("offers no download when the catalog has no published tier", () => {
  const onDownload = vi.fn();
  const pending = MODEL_CATALOG.map((model) => ({
    ...model,
    publishStatus: "pending" as const,
  }));
  render(
    <FirstRunOffer
      catalog={filterSettingsDefaultLocalModels(pending)}
      installed={[]}
      downloads={[]}
      hardware={hardware}
      onDownload={onDownload}
      busy={false}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "No local chat model is available",
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(onDownload).not.toHaveBeenCalled();
});
