/** Non-retryable capability-state coverage for Shared durable memories. */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client-types-core";
import { __resetResourceCache } from "../../hooks/resource-cache";

const clientMock = vi.hoisted(() => ({
  getMemoryStats: vi.fn(),
  getRelationshipsPeople: vi.fn(),
  getMemoryFeed: vi.fn(),
  browseMemories: vi.fn(),
  getMemoriesByEntity: vi.fn(),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: {
      t: (key: string, options?: { defaultValue?: string }) => string;
      setTab: () => void;
    }) => unknown,
  ) =>
    selector({
      t: (_key, options) => options?.defaultValue ?? _key,
      setTab: vi.fn(),
    }),
}));

import { MemoryViewerView } from "./MemoryViewerView";

function runtimeUnavailable(): ApiError {
  return new ApiError({
    kind: "http",
    path: "/api/memories",
    message:
      "Durable memories are not enabled for this Shared agent right now.",
    status: 503,
    code: "memory_runtime_unavailable",
    data: { retryable: false },
  });
}

function mockDesktopViewport() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function expectUnavailableState() {
  expect(
    screen.getByTestId("memory-runtime-unavailable").textContent,
  ).toContain("Memories unavailable");
  expect(
    screen.getByTestId("memory-runtime-unavailable").textContent,
  ).toContain("Durable memories aren't available here.");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByTestId("memory-viewer-sidebar")).toBeNull();
  expect(screen.queryByTestId("memory-view-feed")).toBeNull();
  expect(screen.queryByTestId("memory-view-browse")).toBeNull();
}

beforeEach(() => {
  mockDesktopViewport();
  __resetResourceCache();
  clientMock.getMemoryStats.mockResolvedValue({ total: 0, byType: {} });
  clientMock.getRelationshipsPeople.mockResolvedValue({ people: [] });
  clientMock.getMemoryFeed.mockResolvedValue({
    memories: [],
    count: 0,
    limit: 50,
    hasMore: false,
  });
  clientMock.browseMemories.mockResolvedValue({
    memories: [],
    total: 0,
    totalIsExact: true,
    hasMore: false,
    limit: 50,
    offset: 0,
  });
  clientMock.getMemoriesByEntity.mockResolvedValue({
    memories: [],
    total: 0,
    totalIsExact: true,
    hasMore: false,
    limit: 50,
    offset: 0,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const mock of Object.values(clientMock)) mock.mockReset();
});

describe("MemoryViewerView Shared runtime availability", () => {
  it("collapses a typed stats failure into one non-retryable page state", async () => {
    clientMock.getMemoryStats.mockRejectedValue(runtimeUnavailable());

    render(<MemoryViewerView />);

    await screen.findByTestId("memory-runtime-unavailable");
    expectUnavailableState();
  });

  it("collapses a typed feed failure into the same page state", async () => {
    clientMock.getMemoryFeed.mockRejectedValue(runtimeUnavailable());

    render(<MemoryViewerView />);

    await screen.findByTestId("memory-runtime-unavailable");
    expectUnavailableState();
  });

  it("treats a missing memory endpoint as one unavailable page state", async () => {
    vi.useFakeTimers();
    clientMock.getMemoryFeed.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/memories/feed",
        message: "Not found",
        status: 404,
      }),
    );

    render(<MemoryViewerView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(screen.getByTestId("memory-runtime-unavailable")).not.toBeNull();
    expectUnavailableState();
    expect(screen.queryByText("Not found")).toBeNull();
  });

  it("collapses a typed browse failure into the same page state", async () => {
    clientMock.browseMemories.mockRejectedValue(runtimeUnavailable());

    render(<MemoryViewerView />);
    fireEvent.click(await screen.findByTestId("memory-view-browse"));

    await waitFor(() =>
      expect(screen.getByTestId("memory-runtime-unavailable")).not.toBeNull(),
    );
    expectUnavailableState();
  });
});
