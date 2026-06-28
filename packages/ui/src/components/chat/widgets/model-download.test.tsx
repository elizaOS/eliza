// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LocalInferenceSlotReadiness,
  ModelHubSnapshot,
} from "../../../services/local-inference/types";

// The widget reads via the typed client (getLocalInferenceHub /
// startLocalInferenceDownload) — mock both. getLocalInferenceHub is overridden
// per-test; startLocalInferenceDownload is a spy we assert the retry against.
const { getHubMock, startDownloadMock } = vi.hoisted(() => ({
  getHubMock: vi.fn(),
  startDownloadMock: vi.fn(),
}));
vi.mock("../../../api", () => ({
  client: {
    getLocalInferenceHub: getHubMock,
    startLocalInferenceDownload: startDownloadMock,
  },
}));

// Isolate the navigation rail — assert the CustomEvent without the slash-command
// controller side effects.
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));

// EventSource cannot open in jsdom; the widget already tolerates a null
// EventSource (native-IPC fallback). Force the null path so the test drives off
// the single initial hub fetch.
vi.mock("../../../utils/event-source", () => ({
  openEventSource: () => null,
}));

import { ModelDownloadWidget } from "./model-download";

function slot(
  overrides: Partial<LocalInferenceSlotReadiness>,
): LocalInferenceSlotReadiness {
  return {
    slot: "TEXT_LARGE",
    assigned: true,
    assignedModelId: "eliza-1-2b",
    displayName: "Eliza-1 2B",
    primaryDownloaded: false,
    downloaded: false,
    active: false,
    ready: false,
    state: "downloading",
    requiredModelIds: ["eliza-1-2b"],
    missingModelIds: [],
    installedBytes: 0,
    expectedBytes: 0,
    download: {
      state: "downloading",
      receivedBytes: 0,
      totalBytes: 0,
      percent: null,
      bytesPerSec: 0,
      etaMs: null,
      updatedAt: null,
      errors: [],
    },
    errors: [],
    ...overrides,
  };
}

function hub(
  slots: Partial<
    Record<"TEXT_SMALL" | "TEXT_LARGE", LocalInferenceSlotReadiness>
  >,
): ModelHubSnapshot {
  const unassigned = slot({
    assigned: false,
    assignedModelId: null,
    displayName: null,
    state: "unassigned",
  });
  return {
    catalog: [],
    installed: [],
    active: { modelId: null, loadedAt: null, status: "idle" },
    downloads: [],
    hardware: {} as ModelHubSnapshot["hardware"],
    assignments: {} as ModelHubSnapshot["assignments"],
    textReadiness: {
      updatedAt: "2026-01-01T00:00:00.000Z",
      slots: {
        TEXT_SMALL: slots.TEXT_SMALL ?? { ...unassigned, slot: "TEXT_SMALL" },
        TEXT_LARGE: slots.TEXT_LARGE ?? { ...unassigned, slot: "TEXT_LARGE" },
      },
    },
  };
}

describe("ModelDownloadWidget", () => {
  beforeEach(() => {
    getHubMock.mockReset();
    startDownloadMock.mockReset();
    startDownloadMock.mockResolvedValue({ job: {} });
  });
  afterEach(cleanup);

  it("self-hides (null) when no local text slot is assigned (cloud/remote)", async () => {
    getHubMock.mockResolvedValue(hub({}));
    const { container } = render(<ModelDownloadWidget />);
    await waitFor(() => expect(getHubMock).toHaveBeenCalled());
    // No card ever renders — not-required collapses to null.
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="chat-widget-model-download"]'),
      ).toBeNull(),
    );
  });

  it("self-hides (null) when every assigned slot is ready", async () => {
    getHubMock.mockResolvedValue(
      hub({
        TEXT_LARGE: slot({
          state: "active",
          ready: true,
          active: true,
          downloaded: true,
          primaryDownloaded: true,
        }),
      }),
    );
    const { container } = render(<ModelDownloadWidget />);
    await waitFor(() => expect(getHubMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="chat-widget-model-download"]'),
      ).toBeNull(),
    );
  });

  it("renders the download percent while downloading", async () => {
    getHubMock.mockResolvedValue(
      hub({
        TEXT_LARGE: slot({
          state: "downloading",
          download: {
            state: "downloading",
            receivedBytes: 42,
            totalBytes: 100,
            percent: 42,
            bytesPerSec: 10,
            etaMs: 120_000,
            updatedAt: null,
            errors: [],
          },
        }),
      }),
    );
    render(<ModelDownloadWidget />);
    const card = await screen.findByTestId("chat-widget-model-download");
    expect(card.textContent).toContain("Eliza-1 2B");
    expect(card.textContent).toContain("42%");
    // ETA meta rendered from the server etaMs (2 minutes).
    expect(card.textContent).toContain("2m left");
  });

  it("renders a queued state for an assigned-but-missing slot", async () => {
    getHubMock.mockResolvedValue(
      hub({ TEXT_LARGE: slot({ state: "missing" }) }),
    );
    render(<ModelDownloadWidget />);
    const card = await screen.findByTestId("chat-widget-model-download");
    expect(card.textContent).toContain("Queued");
  });

  it("renders a loading state once downloaded and awaiting activation", async () => {
    getHubMock.mockResolvedValue(
      hub({
        TEXT_LARGE: slot({
          state: "downloaded",
          downloaded: true,
          primaryDownloaded: true,
        }),
      }),
    );
    render(<ModelDownloadWidget />);
    const card = await screen.findByTestId("chat-widget-model-download");
    expect(card.textContent).toContain("Loading");
  });

  it("shows the error state and retries the FAILED model id on tap", async () => {
    getHubMock.mockResolvedValue(
      hub({
        TEXT_LARGE: slot({
          assignedModelId: "eliza-1-4b",
          displayName: "Eliza-1 4B",
          state: "failed",
          errors: ["HuggingFace bundle not published"],
        }),
      }),
    );
    render(<ModelDownloadWidget />);
    const card = await screen.findByTestId("chat-widget-model-download");
    expect(card.getAttribute("aria-label")).toMatch(/download failed/i);
    // Surfaces the readiness error text.
    expect(card.textContent).toContain("HuggingFace bundle");

    fireEvent.click(card);
    await waitFor(() =>
      expect(startDownloadMock).toHaveBeenCalledWith("eliza-1-4b"),
    );
  });

  it("opens local-inference settings on tap when not in an error state", async () => {
    getHubMock.mockResolvedValue(
      hub({ TEXT_LARGE: slot({ state: "downloading" }) }),
    );
    const navigated: string[] = [];
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navigated.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", listener);
    try {
      render(<ModelDownloadWidget />);
      const card = await screen.findByTestId("chat-widget-model-download");
      fireEvent.click(card);
      expect(navigated).toContain("/settings#ai-model");
      // Tapping a non-error card must never enqueue a download.
      expect(startDownloadMock).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("eliza:navigate:view", listener);
    }
  });

  it("settles to null (no spinner) when the hub fetch fails", async () => {
    getHubMock.mockRejectedValue(new Error("bridge hung"));
    const { container } = render(<ModelDownloadWidget />);
    await waitFor(() => expect(getHubMock).toHaveBeenCalled());
    // Initial status is not-required; a failed fetch keeps it → null, never a
    // permanent "Loading…" card.
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="chat-widget-model-download"]'),
      ).toBeNull(),
    );
  });
});
