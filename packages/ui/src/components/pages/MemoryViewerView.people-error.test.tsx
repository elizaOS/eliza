// @vitest-environment jsdom
//
// Three-state guard for the Memories people sidebar (#12784): a failed
// relationships load must render the explicit "Could not load people." error
// row — never the designed "No people yet." healthy-empty state. A 404 (the
// relationships surface isn't hosted on this runtime) IS the designed empty
// state, so it stays on the empty copy.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
    selector: (s: {
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

function mockDesktopViewport() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true, // "(min-width: 820px)" matches → persistent sidebar
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  mockDesktopViewport();
  __resetResourceCache();
  clientMock.getMemoryStats.mockResolvedValue({
    total: 0,
    byType: {},
  });
  clientMock.getMemoryFeed.mockResolvedValue({
    memories: [],
    count: 0,
    limit: 30,
    hasMore: false,
  });
  clientMock.browseMemories.mockResolvedValue({
    memories: [],
    total: 0,
    limit: 30,
    offset: 0,
  });
  clientMock.getMemoriesByEntity.mockResolvedValue({
    memories: [],
    total: 0,
    limit: 30,
    offset: 0,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clientMock.getMemoryStats.mockReset();
  clientMock.getRelationshipsPeople.mockReset();
  clientMock.getMemoryFeed.mockReset();
  clientMock.browseMemories.mockReset();
  clientMock.getMemoriesByEntity.mockReset();
});

describe("MemoryViewerView people sidebar three-state rendering", () => {
  it("renders the error row (not the designed empty state) when the people load fails", async () => {
    clientMock.getRelationshipsPeople.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/relationships/people",
        message: "Internal Server Error",
        status: 500,
      }),
    );

    render(<MemoryViewerView />);

    await waitFor(() =>
      expect(screen.getByTestId("memory-people-error")).not.toBeNull(),
    );
    expect(screen.getByTestId("memory-people-error").textContent).toContain(
      "Could not load people.",
    );
    expect(screen.queryByText("No people yet.")).toBeNull();
  });

  it("renders the error row on a transport failure", async () => {
    clientMock.getRelationshipsPeople.mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    render(<MemoryViewerView />);

    await waitFor(() =>
      expect(screen.getByTestId("memory-people-error")).not.toBeNull(),
    );
    expect(screen.queryByText("No people yet.")).toBeNull();
  });

  it("renders the designed empty state (not an error) when the surface 404s", async () => {
    clientMock.getRelationshipsPeople.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/relationships/people",
        message: "Not Found",
        status: 404,
      }),
    );

    render(<MemoryViewerView />);

    await waitFor(() =>
      expect(screen.getByText("No people yet.")).not.toBeNull(),
    );
    expect(screen.queryByTestId("memory-people-error")).toBeNull();
  });

  it("renders the people list on success", async () => {
    clientMock.getRelationshipsPeople.mockResolvedValue({
      people: [
        {
          groupId: "group-1",
          primaryEntityId: "entity-1",
          memberEntityIds: ["entity-1"],
          displayName: "Ada Lovelace",
          aliases: [],
          platforms: ["discord"],
          identities: [],
          emails: [],
          phones: [],
          websites: [],
          preferredCommunicationChannel: null,
          categories: [],
          tags: [],
          factCount: 3,
          relationshipCount: 1,
        },
      ],
    });

    render(<MemoryViewerView />);

    await waitFor(() =>
      expect(screen.getByText("Ada Lovelace")).not.toBeNull(),
    );
    expect(screen.queryByTestId("memory-people-error")).toBeNull();
    expect(screen.queryByText("No people yet.")).toBeNull();
  });
});
