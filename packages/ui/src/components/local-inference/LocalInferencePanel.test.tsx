// @vitest-environment jsdom

/**
 * Regression coverage for LocalInferencePanel's SSE state reconciliation.
 * The deterministic jsdom harness mocks the local-inference API, child views,
 * and EventSource so downloads-only snapshots cannot erase active model state.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelHubSnapshot } from "../../api/client-local-inference";

const clientMock = vi.hoisted(() => ({
  getLocalInferenceHub: vi.fn(),
  getVoiceModelPreferences: vi.fn(),
  listVoiceModels: vi.fn(),
}));

const eventSourceMock = vi.hoisted(() => ({
  source: {
    close: vi.fn(),
    onerror: null as null | (() => void),
    onmessage: null as null | ((event: MessageEvent) => void),
    readyState: 1,
  },
}));
const appStateMock = vi.hoisted(() => ({
  setActionNotice: vi.fn(),
  t: (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("../../api", () => ({ client: clientMock }));
vi.mock("../../hooks/useRenderGuard", () => ({ useRenderGuard: vi.fn() }));
vi.mock("../../hooks/useRole", () => ({
  useRole: () => ({ isOwner: true }),
}));
vi.mock("../../services/local-inference/catalog-policy", () => ({
  filterSettingsDefaultLocalModels: (models: unknown[]) => models,
  isPublishedLocalModel: (model: unknown) =>
    (model as { publishStatus?: string })?.publishStatus !== "pending",
}));
vi.mock("../../state", () => ({
  useAppSelectorShallow: (selector: (state: unknown) => unknown) =>
    selector(appStateMock),
}));
vi.mock("../../utils/asset-url", () => ({
  resolveApiUrl: (path: string) => path,
}));
vi.mock("../../utils/eliza-globals", () => ({
  getElizaApiToken: () => null,
}));
vi.mock("../../utils/event-source", () => ({
  openEventSource: () => eventSourceMock.source,
}));
vi.mock("../../utils/renderer-diagnostics", () => ({
  reportRendererDiagnostic: vi.fn(),
}));
vi.mock("./useDeviceBridgeStatus", () => ({
  useDeviceBridgeStatus: () => ({}),
}));

vi.mock("./ActiveModelBar", () => ({
  ActiveModelBar: ({ active }: { active: { modelId: string | null } }) => (
    <output data-testid="active-model">{active.modelId ?? "none"}</output>
  ),
}));
vi.mock("./DeviceBridgeStatus", () => ({
  DeviceBridgeStatusBar: () => null,
}));
vi.mock("./DevicesPanel", () => ({ DevicesPanel: () => null }));
vi.mock("./DownloadQueue", () => ({ DownloadQueue: () => null }));
vi.mock("./FirstRunOffer", () => ({ FirstRunOffer: () => null }));
vi.mock("./HardwareBadge", () => ({ HardwareBadge: () => null }));
vi.mock("./ModelHubView", () => ({ ModelHubView: () => null }));
vi.mock("./ModelUpdatesPanel", () => ({ ModelUpdatesPanel: () => null }));
vi.mock("../settings/settings-control-primitives", () => ({
  AdvancedSettingsDisclosure: ({ children }: { children: React.ReactNode }) =>
    children,
}));

import { LocalInferencePanel } from "./LocalInferencePanel";

const unassignedSlot = {
  assigned: false,
  assignedModelId: null,
  displayName: null,
  primaryDownloaded: false,
  downloaded: false,
  active: false,
  ready: false,
  state: "unassigned" as const,
  requiredModelIds: [],
  missingModelIds: [],
  installedBytes: 0,
  expectedBytes: 0,
  errors: [],
  download: {
    state: "missing" as const,
    receivedBytes: 0,
    totalBytes: 0,
    percent: null,
    bytesPerSec: 0,
    etaMs: null,
    updatedAt: null,
    errors: [],
  },
};
const initialHub: ModelHubSnapshot = {
  active: {
    loadedAt: "2026-08-28T00:00:00.000Z",
    modelId: "eliza-1-initial",
    status: "ready",
  },
  catalog: [],
  downloads: [],
  hardware: {
    totalRamGb: 16,
    freeRamGb: 8,
    gpu: null,
    cpuCores: 8,
    platform: "linux",
    arch: "x64",
    appleSilicon: false,
    recommendedBucket: "small",
    source: "os-fallback",
  },
  assignments: {},
  textReadiness: {
    updatedAt: "2026-08-28T00:00:00.000Z",
    slots: {
      TEXT_SMALL: { ...unassignedSlot, slot: "TEXT_SMALL" },
      TEXT_LARGE: { ...unassignedSlot, slot: "TEXT_LARGE" },
    },
  },
  installed: [],
};

beforeEach(() => {
  clientMock.getLocalInferenceHub.mockReset();
  // Keep the unrelated voice bootstrap pending so this focused stream test
  // cannot schedule state updates after its assertions complete.
  clientMock.getVoiceModelPreferences.mockImplementation(
    () => new Promise(() => {}),
  );
  clientMock.listVoiceModels.mockImplementation(() => new Promise(() => {}));
  eventSourceMock.source.close.mockClear();
  eventSourceMock.source.onerror = null;
  eventSourceMock.source.onmessage = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LocalInferencePanel stream snapshots", () => {
  it("preserves authoritative active state when a downloads snapshot omits it", async () => {
    const { promise: hubPromise, resolve: resolveHub } =
      Promise.withResolvers<ModelHubSnapshot>();
    clientMock.getLocalInferenceHub.mockReturnValue(hubPromise);

    render(<LocalInferencePanel />);
    await act(async () => {
      resolveHub(initialHub);
      await hubPromise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("active-model").textContent).toBe(
        "eliza-1-initial",
      );
    });

    act(() => {
      eventSourceMock.source.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ downloads: [], type: "snapshot" }),
        }),
      );
    });

    expect(screen.getByTestId("active-model").textContent).toBe(
      "eliza-1-initial",
    );

    act(() => {
      eventSourceMock.source.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            active: {
              loadedAt: "2026-08-28T00:01:00.000Z",
              modelId: "eliza-1-next",
              status: "ready",
            },
            type: "active",
          }),
        }),
      );
    });

    expect(screen.getByTestId("active-model").textContent).toBe("eliza-1-next");

    act(() => {
      eventSourceMock.source.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "snapshot",
            downloads: [],
            active: { modelId: null, loadedAt: null, status: "idle" },
          }),
        }),
      );
    });
    expect(screen.getByTestId("active-model").textContent).toBe("none");
  });
});
