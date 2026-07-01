// @vitest-environment jsdom
//
// Behavioral coverage for the FULL relationships workspace view — the people
// list (sidebar), auto-selection + detail load, the platform filter + the
// chat-composer-driven search, the loading/empty/error states, the
// stale-response concurrency guard, and the owner-name edit round-trip. The
// candidate-merge panel has its own suite (RelationshipsCandidateMergesPanel.test);
// we keep candidateMerges empty here and do NOT restate that coverage.
//
// The only real seams are the typed API client (`client.*`) and the app store
// (`useAppSelector` -> { t, setTab }). We mock exactly those and assert the
// exact query/payload that reaches the boundary and the resulting DOM mutation.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RelationshipsGraphSnapshot,
  RelationshipsPersonDetail,
  RelationshipsPersonSummary,
} from "../../../api/client-types-relationships";
import { getViewChatBinding } from "../../../state/view-chat-binding";

// ── boundary mocks ──────────────────────────────────────────────────────
const getGraph = vi.fn();
const getPerson = vi.fn();
const updateConfig = vi.fn();
const listDocuments = vi.fn();
const getActivity = vi.fn();

vi.mock("../../../api/client", () => ({
  client: {
    getRelationshipsGraph: (...a: unknown[]) => getGraph(...a),
    getRelationshipsPerson: (...a: unknown[]) => getPerson(...a),
    updateConfig: (...a: unknown[]) => updateConfig(...a),
    listDocuments: (...a: unknown[]) => listDocuments(...a),
    getRelationshipsActivity: (...a: unknown[]) => getActivity(...a),
  },
}));

const setTab = vi.fn();

// Minimal interpolating translator: return the defaultValue with {{k}} filled,
// exactly the strings a user reads (matches the shipped en catalog defaults).
function t(
  key: string,
  options?: { defaultValue?: string } & Record<string, unknown>,
): string {
  let out = options?.defaultValue ?? key;
  if (options) {
    for (const [k, v] of Object.entries(options)) {
      if (k === "defaultValue") continue;
      out = out.replace(new RegExp(`{{\\s*${k}\\s*}}`, "g"), String(v));
    }
  }
  return out;
}

vi.mock("../../../state", () => ({
  useAppSelector: (sel: (v: { t: typeof t; setTab: typeof setTab }) => unknown) =>
    sel({ t, setTab }),
  useAppSelectorShallow: (
    sel: (v: { t: typeof t; setTab: typeof setTab }) => unknown,
  ) => sel({ t, setTab }),
}));

import { RelationshipsWorkspaceView } from "./RelationshipsWorkspaceView";

// ── fixtures ────────────────────────────────────────────────────────────
function makePerson(
  overrides: Partial<RelationshipsPersonSummary> = {},
): RelationshipsPersonSummary {
  const id = overrides.primaryEntityId ?? "entity-x";
  return {
    groupId: overrides.groupId ?? `g-${id}`,
    primaryEntityId: id,
    memberEntityIds: [id],
    displayName: "Person X",
    aliases: [],
    platforms: ["twitter"],
    identities: [],
    emails: [],
    phones: [],
    websites: [],
    preferredCommunicationChannel: null,
    categories: [],
    tags: [],
    factCount: 0,
    relationshipCount: 0,
    isOwner: false,
    profiles: [],
    ...overrides,
  };
}

function makeGraph(
  people: RelationshipsPersonSummary[],
): RelationshipsGraphSnapshot {
  return {
    people,
    relationships: [],
    stats: {
      totalPeople: people.length,
      totalRelationships: 0,
      totalIdentities: 0,
    },
    candidateMerges: [],
  };
}

function makeDetail(
  summary: RelationshipsPersonSummary,
  factText: string,
): RelationshipsPersonDetail {
  return {
    ...summary,
    facts: [
      {
        id: `fact-${summary.primaryEntityId}`,
        sourceType: "claim",
        text: factText,
        confidence: 0.8,
      },
    ],
    recentConversations: [],
    relevantMemories: [],
    relationships: [],
    identityEdges: [],
    userPersonalityPreferences: [],
  };
}

/** A promise plus its resolve/reject handles — controls in-flight timing. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const OWNER = makePerson({
  primaryEntityId: "owner-1",
  groupId: "g-owner",
  displayName: "Ada Owner",
  platforms: ["twitter", "slack"],
  isOwner: true,
});
const BOB = makePerson({
  primaryEntityId: "bob-1",
  groupId: "g-bob",
  displayName: "Bob Contact",
  platforms: ["telegram"],
});

function sidebarButtons() {
  const sidebar = screen.getByTestId("relationships-sidebar");
  return within(sidebar).getAllByRole("button");
}

beforeEach(() => {
  getGraph.mockReset();
  getPerson.mockReset();
  updateConfig.mockReset();
  listDocuments.mockReset();
  getActivity.mockReset();
  setTab.mockReset();
  // Sensible defaults; individual tests override getGraph/getPerson.
  getGraph.mockResolvedValue(makeGraph([OWNER, BOB]));
  getPerson.mockImplementation((id: string) => {
    const summary = id === BOB.primaryEntityId ? BOB : OWNER;
    return Promise.resolve(
      makeDetail(summary, id === BOB.primaryEntityId ? "Bob likes chess" : "Ada runs eliza"),
    );
  });
  updateConfig.mockResolvedValue(undefined);
  listDocuments.mockResolvedValue({ documents: [] });
  getActivity.mockResolvedValue({
    activity: [],
    total: 0,
    count: 0,
    offset: 0,
    limit: 20,
    hasMore: false,
  });
});

afterEach(() => cleanup());

describe("RelationshipsWorkspaceView", () => {
  it("renders one sidebar row per person, owner sorted first", async () => {
    // Feed the graph with the NON-owner first so a "preserve input order" (no
    // sort) regression renders Bob first and fails the assertion below — the
    // default [OWNER, BOB] fixture was already owner-first, so it could not
    // catch that.
    getGraph.mockResolvedValueOnce(makeGraph([BOB, OWNER]));
    render(<RelationshipsWorkspaceView />);

    await waitFor(() => {
      const buttons = sidebarButtons().filter((b) =>
        /Ada Owner|Bob Contact/.test(b.textContent ?? ""),
      );
      expect(buttons.length).toBe(2);
    });

    const rows = sidebarButtons().filter((b) =>
      /Ada Owner|Bob Contact/.test(b.textContent ?? ""),
    );
    // sortPeople() floats the owner above everyone else regardless of input order.
    expect(rows[0].textContent).toContain("Ada Owner");
    expect(rows[1].textContent).toContain("Bob Contact");
    expect(getGraph).toHaveBeenCalledWith({
      search: undefined,
      platform: undefined,
      limit: 200,
    });
  });

  it("auto-selects the first person and loads their detail via getRelationshipsPerson", async () => {
    render(<RelationshipsWorkspaceView />);

    await waitFor(() =>
      expect(getPerson).toHaveBeenCalledWith(OWNER.primaryEntityId),
    );
    // The detail-only fact text proves the person detail (not just the summary
    // list) rendered.
    await waitFor(() =>
      expect(screen.getByText("Ada runs eliza")).toBeTruthy(),
    );
  });

  it("selecting a different person loads that person's detail and swaps the panel", async () => {
    render(<RelationshipsWorkspaceView />);

    await waitFor(() =>
      expect(screen.getByText("Ada runs eliza")).toBeTruthy(),
    );

    const bobRow = sidebarButtons().find((b) =>
      (b.textContent ?? "").includes("Bob Contact"),
    );
    if (!bobRow) throw new Error("Bob sidebar row not found");
    fireEvent.click(bobRow);

    await waitFor(() =>
      expect(getPerson).toHaveBeenCalledWith(BOB.primaryEntityId),
    );
    await waitFor(() => expect(screen.getByText("Bob likes chess")).toBeTruthy());
    // Bob's aria-current marks the active row.
    expect(bobRow.getAttribute("aria-current")).toBe("page");
  });

  it("changing the platform filter refetches the graph with the platform in the query", async () => {
    render(<RelationshipsWorkspaceView />);

    await waitFor(() => expect(getGraph).toHaveBeenCalledTimes(1));

    const select = screen.getByLabelText("Platform filter") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "slack" } });

    await waitFor(() =>
      expect(getGraph).toHaveBeenLastCalledWith({
        search: undefined,
        platform: "slack",
        limit: 200,
      }),
    );
  });

  it("search typed into the bound chat composer filters the graph query", async () => {
    render(<RelationshipsWorkspaceView />);

    await waitFor(() => expect(getGraph).toHaveBeenCalledTimes(1));

    // The view registers a chat binding instead of owning a search input; the
    // floating composer feeds it via onQuery. Exercise the real wiring.
    const binding = getViewChatBinding();
    expect(binding?.onQuery).toBeTypeOf("function");
    fireEvent.change(
      screen.getByLabelText("Platform filter") as HTMLSelectElement,
      { target: { value: "slack" } },
    );
    binding?.onQuery?.("ada");

    await waitFor(() =>
      expect(getGraph).toHaveBeenLastCalledWith({
        search: "ada",
        platform: "slack",
        limit: 200,
      }),
    );
  });

  it("shows the loading panel until the graph resolves", async () => {
    const gate = deferred<RelationshipsGraphSnapshot>();
    getGraph.mockReturnValue(gate.promise);

    render(<RelationshipsWorkspaceView />);

    expect(screen.getByText("Loading...")).toBeTruthy();

    gate.resolve(makeGraph([OWNER]));
    await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());
  });

  it("surfaces the graph load error and renders no people list", async () => {
    getGraph.mockRejectedValue(new Error("relationships graph offline"));

    render(<RelationshipsWorkspaceView />);

    await waitFor(() =>
      expect(screen.getByText("relationships graph offline")).toBeTruthy(),
    );
    expect(screen.getByText("Relationships failed to load")).toBeTruthy();
    expect(getPerson).not.toHaveBeenCalled();
  });

  it("shows the empty state when there are no people", async () => {
    getGraph.mockResolvedValue(makeGraph([]));

    render(<RelationshipsWorkspaceView />);

    await waitFor(() =>
      expect(
        screen.getByText(
          "No relationships yet. Ask Eliza to map who you know.",
        ),
      ).toBeTruthy(),
    );
    // No person detail should be fetched when the graph is empty.
    expect(getPerson).not.toHaveBeenCalled();
  });

  it("ignores a stale in-flight graph response when a newer filter response arrives first (concurrency guard)", async () => {
    // Two calls in flight: mount (all) and the platform change (slack). We
    // resolve the NEWER one first, then the older/stale one — the requestId
    // guard must keep the newer snapshot and drop the stale one.
    const first = deferred<RelationshipsGraphSnapshot>();
    const second = deferred<RelationshipsGraphSnapshot>();
    const queue = [first, second];
    getGraph.mockImplementation(() => (queue.shift() ?? second).promise);

    render(<RelationshipsWorkspaceView />);

    await waitFor(() => expect(getGraph).toHaveBeenCalledTimes(1));
    fireEvent.change(
      screen.getByLabelText("Platform filter") as HTMLSelectElement,
      { target: { value: "slack" } },
    );
    await waitFor(() => expect(getGraph).toHaveBeenCalledTimes(2));

    // Newer (second) resolves first with only Bob...
    second.resolve(makeGraph([BOB]));
    await waitFor(() => {
      const names = sidebarButtons()
        .map((b) => b.textContent ?? "")
        .join("|");
      expect(names).toContain("Bob Contact");
    });

    // ...then the STALE first response (only Ada) resolves late — it must be
    // discarded, so Ada must NOT appear and Bob must remain.
    first.resolve(makeGraph([OWNER]));
    await new Promise((r) => setTimeout(r, 0));

    const names = sidebarButtons()
      .map((b) => b.textContent ?? "")
      .join("|");
    expect(names).toContain("Bob Contact");
    expect(names).not.toContain("Ada Owner");
  });

  it("owner-name edit persists via updateConfig and refreshes the graph", async () => {
    const user = userEvent.setup();
    getGraph.mockResolvedValue(makeGraph([OWNER]));

    render(<RelationshipsWorkspaceView />);

    // Owner detail renders the editable-name trigger button.
    const editTrigger = await screen.findByLabelText("Edit owner name");
    await user.click(editTrigger);

    const input = (await screen.findByLabelText(
      "Owner name",
    )) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Ada Renamed");
    // DOM round-trip: the controlled input reflects the typed draft.
    expect(input.value).toBe("Ada Renamed");

    const graphCallsBefore = getGraph.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        ui: { ownerName: "Ada Renamed" },
      }),
    );
    // The successful save triggers a graph refresh (onOwnerNameUpdated).
    await waitFor(() =>
      expect(getGraph.mock.calls.length).toBeGreaterThan(graphCallsBefore),
    );
  });

  it("does NOT persist an unchanged owner name (no-op guard)", async () => {
    const user = userEvent.setup();
    getGraph.mockResolvedValue(makeGraph([OWNER]));

    render(<RelationshipsWorkspaceView />);

    const editTrigger = await screen.findByLabelText("Edit owner name");
    await user.click(editTrigger);
    // Submit without changing the name.
    await screen.findByLabelText("Owner name");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Unchanged draft === initialName -> early return, boundary untouched...
    expect(updateConfig).not.toHaveBeenCalled();
    // ...and the editor closes back to the display button.
    await waitFor(() =>
      expect(screen.queryByLabelText("Owner name")).toBeNull(),
    );
  });

  it("does NOT persist a whitespace-only owner name (adversarial input)", async () => {
    const user = userEvent.setup();
    getGraph.mockResolvedValue(makeGraph([OWNER]));

    render(<RelationshipsWorkspaceView />);

    const editTrigger = await screen.findByLabelText("Edit owner name");
    await user.click(editTrigger);
    const input = (await screen.findByLabelText(
      "Owner name",
    )) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "    ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Trimmed-empty name must never reach the config boundary.
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
