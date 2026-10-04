/** Exercises the rendered Settings download action against real catalog publication and hardware policy. */
// @vitest-environment jsdom

// @vitest-environment jsdom
import type { HardwareProbe } from "@elizaos/contracts";
import {
  filterSettingsDefaultLocalModels,
  MODEL_CATALOG,
} from "@elizaos/plugin-native-inference/model-catalog/catalog";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
// The published tiers as they will be served once their manifests pass the
// activation gate (the shipped snapshot marks today's candidates ineligible).
const PASSING_CATALOG = MODEL_CATALOG.map((model) =>
  model.publishStatus === "published"
    ? { ...model, activationEligible: true }
    : model,
);
afterEach(cleanup);
it("offers no download while the published manifests are activation-ineligible candidates", () => {
  const onDownload = vi.fn();
  render(
    <FirstRunOffer
      catalog={filterSettingsDefaultLocalModels(MODEL_CATALOG)}
      installed={[]}
      downloads={[]}
      hardware={hardware}
      onDownload={onDownload}
      busy={false}
    />,
  );
  const alert = screen.getByRole("alert").textContent ?? "";
  expect(alert).toContain("No local chat model is available");
  expect(alert).toContain("Eliza Cloud");
  expect(screen.queryByRole("button")).toBeNull();
  expect(onDownload).not.toHaveBeenCalled();
});
it("dispatches a published download even when a larger pending tier fits the Mac", () => {
  const onDownload = vi.fn();
  render(
    <FirstRunOffer
      catalog={filterSettingsDefaultLocalModels(PASSING_CATALOG)}
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
  expect(
    PASSING_CATALOG.find((model) => model.id === selected?.id)
      ?.activationEligible,
  ).toBe(true);
});
it("offers no download when the catalog has no published tier", () => {
  const onDownload = vi.fn();
  const pending = PASSING_CATALOG.map((model) => ({
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
