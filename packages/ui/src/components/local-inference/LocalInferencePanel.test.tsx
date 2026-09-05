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

const initialHub = {
  active: {
    loadedAt: "2026-08-28T00:00:00.000Z",
    modelId: "eliza-1-initial",
    status: "ready",
  },
  catalog: [],
  downloads: [],
  hardware: {},
  installed: [],
} as unknown as ModelHubSnapshot;

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
    let resolveHub: (hub: ModelHubSnapshot) => void = () => {};
    const hubPromise = new Promise<ModelHubSnapshot>((resolve) => {
      resolveHub = resolve;
    });
    clientMock.getLocalInferenceHub.mockReturnValue(hubPromise);

    render(<LocalInferencePanel />);
    await act(async () => {
      resolveHub(initialHub);
      await hubPromise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(screen.getByTestId("active-model").textContent).toBe(
        "eliza-1-initial",
      );
    });

    act(() => {
      eventSourceMock.source.onmessage?.({
        data: JSON.stringify({ downloads: [], type: "snapshot" }),
      } as MessageEvent);
    });

    expect(screen.getByTestId("active-model").textContent).toBe(
      "eliza-1-initial",
    );

    act(() => {
      eventSourceMock.source.onmessage?.({
        data: JSON.stringify({
          active: {
            loadedAt: "2026-08-28T00:01:00.000Z",
            modelId: "eliza-1-next",
            status: "ready",
          },
          type: "active",
        }),
      } as MessageEvent);
    });

    expect(screen.getByTestId("active-model").textContent).toBe("eliza-1-next");
  });
});
