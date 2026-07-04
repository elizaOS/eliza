// @vitest-environment jsdom
//
// Memories on mobile: guards that the people/filter sidebar opens from the
// compact "People" control in the view header's right slot, not from an inline
// trigger between the centered header and the content. Covers the
// `WorkspaceMobileSidebarScope` + `ViewHeaderSidebarTrigger` wiring in
// MemoryViewerView.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetResourceCache } from "../../hooks/resource-cache";

// MemoryViewerView talks to the runtime through the `client` singleton — mock
// that data seam and the app-store selector; layout, header, drawer, and the
// scope wiring under test all render for real.
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

function mockMobileViewport() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, // "(min-width: 820px)" never matches → mobile layout
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

const person = {
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
};

beforeEach(() => {
  mockMobileViewport();
  __resetResourceCache();
  clientMock.getMemoryStats.mockResolvedValue({
    total: 3,
    byType: { facts: 3 },
  });
  clientMock.getRelationshipsPeople.mockResolvedValue({ people: [person] });
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

describe("MemoryViewerView mobile sidebar header trigger", () => {
  it("renders the People trigger in the view header and no inline trigger in the content", async () => {
    render(<MemoryViewerView />);

    await waitFor(() =>
      expect(clientMock.getRelationshipsPeople).toHaveBeenCalled(),
    );

    const triggers = screen.getAllByTestId(
      "page-layout-mobile-sidebar-trigger",
    );
    expect(triggers).toHaveLength(1);
    expect(triggers[0].textContent).toContain("People");
    expect(
      within(screen.getByTestId("view-header")).getByTestId(
        "page-layout-mobile-sidebar-trigger",
      ),
    ).toBe(triggers[0]);
    // The old orphan placement: inside the PageLayout main pane, below the header.
    expect(triggers[0].closest("main")).toBeNull();
  });

  it("opens the people drawer from the header control", async () => {
    render(<MemoryViewerView />);

    await waitFor(() =>
      expect(clientMock.getRelationshipsPeople).toHaveBeenCalled(),
    );

    fireEvent.click(screen.getByTestId("page-layout-mobile-sidebar-trigger"));

    const drawer = screen.getByTestId("page-layout-mobile-sidebar-drawer");
    await waitFor(() =>
      expect(within(drawer).getByText("Ada Lovelace")).not.toBeNull(),
    );
    // Drawer open → the header control steps aside (drawer owns closing).
    expect(
      screen.queryByTestId("page-layout-mobile-sidebar-trigger"),
    ).toBeNull();
  });
});
