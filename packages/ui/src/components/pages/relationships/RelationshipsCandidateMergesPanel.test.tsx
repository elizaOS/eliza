// @vitest-environment jsdom
//
// Behavioral coverage for the identity-merge candidate panel — the most
// dangerous relationships surface, since Accept mutates the identity graph by
// fusing two entities. Zero prior coverage. We mock only the API/merge-engine
// boundary (client.acceptRelationshipsCandidate / rejectRelationshipsCandidate)
// and assert: the right candidate id reaches the right call, reject never
// merges, a rapid double-click does NOT double-merge (idempotency via the
// pending guard), the failure path surfaces the error without signalling
// resolution, and an empty candidate list renders nothing.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RelationshipsGraphSnapshot,
  RelationshipsMergeCandidate,
} from "../../../api/client-types-relationships";

const acceptCandidate = vi.fn();
const rejectCandidate = vi.fn();

vi.mock("../../../api/client", () => ({
  client: {
    acceptRelationshipsCandidate: (...args: unknown[]) =>
      acceptCandidate(...args),
    rejectRelationshipsCandidate: (...args: unknown[]) =>
      rejectCandidate(...args),
  },
}));

import { RelationshipsCandidateMergesPanel } from "./RelationshipsCandidateMergesPanel";

function makeCandidate(
  overrides: Partial<RelationshipsMergeCandidate> = {},
): RelationshipsMergeCandidate {
  return {
    id: "cand-1",
    entityA: "entity-a",
    entityB: "entity-b",
    confidence: 0.9,
    evidence: { platform: "twitter", handle: "ada", identityIds: ["i1", "i2"] },
    status: "pending",
    proposedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeGraph(
  candidates: RelationshipsMergeCandidate[],
): RelationshipsGraphSnapshot {
  return {
    people: [
      {
        groupId: "g-a",
        primaryEntityId: "entity-a",
        memberEntityIds: ["entity-a"],
        displayName: "Ada Lovelace",
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
      },
      {
        groupId: "g-b",
        primaryEntityId: "entity-b",
        memberEntityIds: ["entity-b"],
        displayName: "Ada (alt)",
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
      },
    ],
    relationships: [],
    stats: { totalPeople: 2, totalRelationships: 0, totalIdentities: 2 },
    candidateMerges: candidates,
  };
}

/** A promise plus its resolve/reject handles, to control in-flight timing. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  acceptCandidate.mockReset();
  rejectCandidate.mockReset();
  acceptCandidate.mockResolvedValue(undefined);
  rejectCandidate.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("RelationshipsCandidateMergesPanel", () => {
  it("renders one row per pending candidate with both person labels and confidence", () => {
    const onResolved = vi.fn();
    const { container } = render(
      <RelationshipsCandidateMergesPanel
        graph={makeGraph([makeCandidate()])}
        onResolved={onResolved}
      />,
    );
    // personLabel resolves member entity ids to display names on both sides
    // (rendered as "A ↔ B" across sibling text nodes in one row).
    const text = container.textContent ?? "";
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("Ada (alt)");
    // confidence rendered as rounded percent.
    expect(screen.getByText("90%")).toBeTruthy();
  });

  it("Accept fires the merge for the exact candidate id, then signals onResolved", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn();
    render(
      <RelationshipsCandidateMergesPanel
        graph={makeGraph([makeCandidate({ id: "cand-42" })])}
        onResolved={onResolved}
      />,
    );

    await user.click(screen.getByRole("button", { name: /accept/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(acceptCandidate).toHaveBeenCalledTimes(1);
    expect(acceptCandidate).toHaveBeenCalledWith("cand-42");
    // Accept must NOT reach the reject/dismiss path.
    expect(rejectCandidate).not.toHaveBeenCalled();
  });

  it("Reject dismisses via the reject call and never merges", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn();
    render(
      <RelationshipsCandidateMergesPanel
        graph={makeGraph([makeCandidate({ id: "cand-7" })])}
        onResolved={onResolved}
      />,
    );

    await user.click(screen.getByRole("button", { name: /reject/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(rejectCandidate).toHaveBeenCalledTimes(1);
    expect(rejectCandidate).toHaveBeenCalledWith("cand-7");
    // The dangerous path (identity merge) must never fire on a reject.
    expect(acceptCandidate).not.toHaveBeenCalled();
  });

  it("does NOT double-merge on a rapid double-click (pending guard)", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn();
    // Hold the merge in-flight so the button stays disabled between clicks.
    const gate = deferred<undefined>();
    acceptCandidate.mockReturnValue(gate.promise);

    render(
      <RelationshipsCandidateMergesPanel
        graph={makeGraph([makeCandidate({ id: "cand-1" })])}
        onResolved={onResolved}
      />,
    );

    const acceptButton = screen.getByRole("button", { name: /accept/i });
    await user.click(acceptButton);

    // While the merge is in-flight the control shows the working state and is
    // disabled — a second click must be a no-op, not a second merge.
    await waitFor(() =>
      expect(acceptButton.hasAttribute("disabled")).toBe(true),
    );
    expect(acceptButton.textContent).toContain("Working");

    await user.click(acceptButton);
    await user.click(acceptButton);

    // The identity graph must be mutated exactly once regardless of clicks.
    expect(acceptCandidate).toHaveBeenCalledTimes(1);

    gate.resolve(undefined);
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it("surfaces the merge error and does NOT signal resolution when the call fails", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn();
    acceptCandidate.mockRejectedValue(new Error("merge engine offline"));

    render(
      <RelationshipsCandidateMergesPanel
        graph={makeGraph([makeCandidate({ id: "cand-1" })])}
        onResolved={onResolved}
      />,
    );

    const acceptButton = screen.getByRole("button", { name: /accept/i });
    await user.click(acceptButton);

    // The real error message is shown to the user...
    await waitFor(() =>
      expect(screen.getByText("merge engine offline")).toBeTruthy(),
    );
    // ...the graph is NOT reported as resolved (no stale refresh on failure)...
    expect(onResolved).not.toHaveBeenCalled();
    // ...and the control is re-enabled so the user can retry.
    await waitFor(() =>
      expect(acceptButton.hasAttribute("disabled")).toBe(false),
    );
  });

  it("renders nothing when there are no candidate merges", () => {
    const { container } = render(
      <RelationshipsCandidateMergesPanel
        graph={makeGraph([])}
        onResolved={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
