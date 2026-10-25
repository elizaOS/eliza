// @vitest-environment jsdom
/**
 * Redownload uninstalls before it re-queues the download, so both hub surfaces
 * must offer it only for an installed model the downloader would still accept.
 */
import type {
  ActiveModelState,
  CatalogModel,
  HardwareProbe,
  InstalledModel,
} from "@elizaos/contracts";
import { MODEL_CATALOG } from "@elizaos/plugin-native-inference/model-catalog/catalog";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TranslationProvider } from "../../../state/TranslationProvider";
import { canRedownloadInstalledModel } from "../hub-utils";
import { ModelCard } from "../ModelCard";
import { ModelHubView } from "../ModelHubView";

afterEach(cleanup);

const tier = MODEL_CATALOG.find((model) => model.id === "eliza-1-2b");
if (!tier) throw new Error("eliza-1-2b missing from the curated catalog");

/** Entry fields win over the id-keyed snapshot, as when served over the API. */
const offerable: CatalogModel = {
  ...tier,
  publishStatus: "published",
  activationEligible: true,
};
const candidate: CatalogModel = { ...offerable, activationEligible: false };
const pending: CatalogModel = { ...offerable, publishStatus: "pending" };

const installedEntry = (source: InstalledModel["source"]): InstalledModel => ({
  id: tier.id,
  displayName: tier.displayName,
  path: `/models/${tier.ggufFile}`,
  sizeBytes: 2_400_000_000,
  installedAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: null,
  source,
});

const hardware: HardwareProbe = {
  totalRamGb: 64,
  freeRamGb: 48,
  gpu: { backend: "metal", totalVramGb: 32, freeVramGb: 24 },
  cpuCores: 10,
  platform: "darwin",
  arch: "arm64",
  appleSilicon: true,
  recommendedBucket: "large",
  source: "os-fallback",
};

const active: ActiveModelState = {
  modelId: null,
  loadedAt: null,
  status: "idle",
};

const handlers = () => ({
  onDownload: vi.fn(),
  onCancel: vi.fn(),
  onActivate: vi.fn(),
  onUninstall: vi.fn(),
  onVerify: vi.fn(),
  onRedownload: vi.fn(),
});

const mount = (ui: ReactElement) =>
  render(<TranslationProvider>{ui}</TranslationProvider>);

const surfaces = {
  card: (model: CatalogModel, installed: InstalledModel[]) => {
    const h = handlers();
    mount(
      <ModelCard
        model={model}
        hardware={hardware}
        installed={installed}
        downloads={[]}
        active={active}
        busy={false}
        {...h}
      />,
    );
    return h;
  },
  hubRow: (model: CatalogModel, installed: InstalledModel[]) => {
    const h = handlers();
    mount(
      <ModelHubView
        catalog={[model]}
        hardware={hardware}
        installed={installed}
        downloads={[]}
        active={active}
        busy={false}
        {...h}
      />,
    );
    return h;
  },
};

const redownload = () => screen.queryByRole("button", { name: "Redownload" });

it("decides redownload from install source and catalog offerability", () => {
  const managed = installedEntry("eliza-download");
  expect(canRedownloadInstalledModel(offerable, managed)).toBe(true);
  expect(canRedownloadInstalledModel(candidate, managed)).toBe(false);
  expect(canRedownloadInstalledModel(pending, managed)).toBe(false);
  expect(
    canRedownloadInstalledModel(
      { ...offerable, hiddenFromCatalog: true },
      managed,
    ),
  ).toBe(false);
  expect(
    canRedownloadInstalledModel(offerable, installedEntry("external-scan")),
  ).toBe(false);
  expect(canRedownloadInstalledModel(offerable, undefined)).toBe(false);
});

for (const [name, mountSurface] of Object.entries(surfaces)) {
  it(`${name}: offers Redownload for an installed, still-offerable model`, () => {
    const h = mountSurface(offerable, [installedEntry("eliza-download")]);
    const button = redownload();
    expect(button).not.toBeNull();
    if (button) fireEvent.click(button);
    expect(h.onRedownload).toHaveBeenCalledWith(tier.id);
  });

  it(`${name}: hides Redownload when the download would be refused, keeping Uninstall`, () => {
    for (const model of [candidate, pending]) {
      mountSurface(model, [installedEntry("eliza-download")]);
      expect(redownload()).toBeNull();
      expect(screen.queryByRole("button", { name: "Uninstall" })).not.toBeNull();
      cleanup();
    }
  });
}
