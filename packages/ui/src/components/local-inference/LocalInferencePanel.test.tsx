// @vitest-environment jsdom

/**
 * Exercises local model management and SSE state reconciliation in jsdom.
 * The model list, first-run recommendation and publication policy are real;
 * API transport, device services and EventSource are deterministic fixtures.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelHubSnapshot } from "../../api/client-local-inference";
import { MODEL_CATALOG } from "../../services/local-inference/catalog";

const clientMock = vi.hoisted(() => ({
  getLocalInferenceHub: vi.fn(),
  startLocalInferenceDownload: vi.fn().mockResolvedValue(undefined),
  cancelLocalInferenceDownload: vi.fn().mockResolvedValue(undefined),
  uninstallLocalInferenceModel: vi.fn().mockResolvedValue(undefined),
  getVoiceModelPreferences: vi.fn(),
  listVoiceModels: vi.fn(),
}));

const eventSourceMock = vi.hoisted(() => ({
  available: true,
  source: {
    close: vi.fn(),
    onopen: null as null | (() => void),
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
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({ t: appStateMock.t }),
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
  openEventSource: () =>
    eventSourceMock.available ? eventSourceMock.source : null,
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
vi.mock("./HardwareBadge", () => ({ HardwareBadge: () => null }));
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
  eventSourceMock.available = true;
  eventSourceMock.source.onopen = null;
  eventSourceMock.source.close.mockClear();
  eventSourceMock.source.onerror = null;
  eventSourceMock.source.onmessage = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

it("keeps an installed unpublished model removable without offering it as a fresh download", async () => {
  const baseModel = MODEL_CATALOG[0];
  if (!baseModel) throw new Error("Local catalog fixture unavailable");
  const model = { ...baseModel, publishStatus: "pending" as const };
  const installedHub: ModelHubSnapshot = {
    ...initialHub,
    active: { modelId: null, loadedAt: null, status: "idle" },
    catalog: [model],
    installed: [
      {
        id: model.id,
        displayName: model.id,
        path: `/models/${model.ggufFile}`,
        sizeBytes: 1000,
        installedAt: "2026-08-28T00:00:00.000Z",
        lastUsedAt: null,
        source: "eliza-download",
      },
    ],
  };
  clientMock.getLocalInferenceHub
    .mockResolvedValueOnce(installedHub)
    .mockResolvedValue({ ...installedHub, installed: [] });
  render(<LocalInferencePanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Uninstall" }));
  await waitFor(() =>
    expect(clientMock.uninstallLocalInferenceModel).toHaveBeenCalledWith(
      model.id,
    ),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Uninstall" })).toBeNull(),
  );
  expect(
    screen.queryByRole("button", { name: "Download default model" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
});

describe("download snapshots without a usable stream", () => {
  const job = {
    jobId: "native-download",
    modelId: "eliza-1-2b",
    state: "downloading" as const,
    received: 20,
    total: 100,
    bytesPerSec: 10,
    etaMs: 8000,
    startedAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:01.000Z",
  };

  it.each(["unavailable", "rejected"])(
    "reconciles progress and completion when streaming is %s and stops after unmount",
    async (stream) => {
      vi.useFakeTimers();
      eventSourceMock.available = stream !== "unavailable";
      clientMock.getLocalInferenceHub.mockResolvedValue(initialHub);
      const view = render(<LocalInferencePanel />);
      await act(async () => {});
      if (stream === "rejected") {
        act(() => eventSourceMock.source.onopen?.());
        await act(async () => {});
        act(() => eventSourceMock.source.onerror?.());
      }
      fireEvent.click(screen.getByRole("button", { name: /Downloads/ }));
      expect(screen.getByText(/No downloads in progress/)).toBeTruthy();

      const pending = Promise.withResolvers<ModelHubSnapshot>();
      clientMock.getLocalInferenceHub.mockReturnValue(pending.promise);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      const calls = clientMock.getLocalInferenceHub.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(clientMock.getLocalInferenceHub.mock.calls.length).toBe(calls);
      await act(async () => {
        pending.resolve({ ...initialHub, downloads: [job] });
      });
      expect(
        screen.getByRole("progressbar").getAttribute("aria-valuenow"),
      ).toBe("20");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

      clientMock.getLocalInferenceHub.mockResolvedValue({
        ...initialHub,
        downloads: [{ ...job, received: 70 }],
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(
        screen.getByRole("progressbar").getAttribute("aria-valuenow"),
      ).toBe("70");
      clientMock.getLocalInferenceHub.mockResolvedValue(initialHub);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.getByText(/No downloads in progress/)).toBeTruthy();
      view.unmount();
      const finalCalls = clientMock.getLocalInferenceHub.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(clientMock.getLocalInferenceHub.mock.calls.length).toBe(
        finalCalls,
      );
    },
  );

  it.each(["resolve", "reject"])(
    "ignores a pre-cancellation poll that later %ss after cancellation refresh",
    async (settlement) => {
      vi.useFakeTimers();
      eventSourceMock.available = false;
      clientMock.getLocalInferenceHub.mockResolvedValue({
        ...initialHub,
        downloads: [job],
      });
      render(<LocalInferencePanel />);
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: /Downloads/ }));

      const stale = Promise.withResolvers<ModelHubSnapshot>();
      clientMock.getLocalInferenceHub
        .mockReturnValueOnce(stale.promise)
        .mockResolvedValue(initialHub);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      });
      expect(screen.getByText(/No downloads in progress/)).toBeTruthy();
      await act(async () => {
        if (settlement === "resolve") {
          stale.resolve({ ...initialHub, downloads: [job] });
        } else {
          stale.reject(new Error("Obsolete snapshot failed"));
        }
      });
      expect(screen.getByText(/No downloads in progress/)).toBeTruthy();
      expect(screen.queryByRole("progressbar")).toBeNull();
      expect(screen.queryByText("Obsolete snapshot failed")).toBeNull();
    },
  );

  it("retains downloads and exposes a retry when a fallback snapshot fails", async () => {
    vi.useFakeTimers();
    eventSourceMock.available = false;
    clientMock.getLocalInferenceHub.mockResolvedValue({
      ...initialHub,
      downloads: [job],
    });
    render(<LocalInferencePanel />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /Downloads/ }));
    clientMock.getLocalInferenceHub.mockRejectedValueOnce(
      new Error("Snapshot unavailable"),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(
      screen.getByText("Snapshot unavailable").closest('[role="alert"]'),
    ).not.toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "20",
    );
    clientMock.getLocalInferenceHub.mockResolvedValue(initialHub);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.queryByText("Snapshot unavailable")).toBeNull();
    expect(screen.getByText(/No downloads in progress/)).toBeTruthy();
  });

  it("reconciles completion received before the first hub snapshot", async () => {
    const initial = Promise.withResolvers<ModelHubSnapshot>();
    const opened = Promise.withResolvers<ModelHubSnapshot>();
    clientMock.getLocalInferenceHub
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(opened.promise)
      .mockResolvedValue(initialHub);
    render(<LocalInferencePanel />);
    act(() => eventSourceMock.source.onopen?.());
    act(() => {
      eventSourceMock.source.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "completed", job }),
        }),
      );
    });
    await act(async () => {
      opened.resolve({ ...initialHub, downloads: [job] });
      initial.resolve({ ...initialHub, downloads: [job] });
    });
    fireEvent.click(screen.getByRole("button", { name: /Downloads/ }));
    expect(screen.getByText(/No downloads in progress/)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("does not roll stream progress back when an earlier refresh resolves", async () => {
    clientMock.getLocalInferenceHub.mockResolvedValue({
      ...initialHub,
      downloads: [job],
    });
    render(<LocalInferencePanel />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /Downloads/ }));
    const stale = Promise.withResolvers<ModelHubSnapshot>();
    clientMock.getLocalInferenceHub.mockReturnValueOnce(stale.promise);
    act(() => eventSourceMock.source.onopen?.());
    act(() => {
      eventSourceMock.source.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "progress",
            job: { ...job, received: 70 },
          }),
        }),
      );
    });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "70",
    );
    await act(async () => {
      stale.resolve({ ...initialHub, downloads: [job] });
    });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "70",
    );
  });

  it("refreshes immediately after download and cancellation without waiting for streaming", async () => {
    eventSourceMock.available = false;
    const hub = {
      ...initialHub,
      active: { modelId: null, loadedAt: null, status: "idle" as const },
      catalog: [MODEL_CATALOG[0]],
    };
    clientMock.getLocalInferenceHub.mockResolvedValue(hub);
    render(<LocalInferencePanel />);
    const download = await screen.findByRole("button", {
      name: "Download default model",
    });
    clientMock.getLocalInferenceHub.mockResolvedValue({
      ...hub,
      downloads: [job],
    });
    fireEvent.click(download);
    fireEvent.click(screen.getByRole("button", { name: /Downloads/ }));
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    clientMock.getLocalInferenceHub.mockResolvedValue(hub);
    fireEvent.click(cancel);
    await screen.findByText(/No downloads in progress/);
    expect(clientMock.startLocalInferenceDownload).toHaveBeenCalledWith(
      job.modelId,
    );
    expect(clientMock.cancelLocalInferenceDownload).toHaveBeenCalledWith(
      job.modelId,
    );
  });
});
