/**
 * Covers the pure derivation helpers behind the Relationships view.
 *
 * `sortPeople` is the load-bearing one: it is a four-level comparator (owner
 * first, then recency, then relationship count, then name) whose recency key is
 * an ISO string from an adapter row, so an absent or unparseable date must not
 * be able to reorder the people around it. The remaining helpers are display
 * derivations where the failure mode is a silently wrong label rather than a
 * crash, so each is pinned to its exact output.
 *
 * No React, no IO.
 */
import { describe, expect, it } from "vitest";

import type {
  RelationshipsGraphSnapshot,
  RelationshipsMergeCandidate,
  RelationshipsPersonDetail,
  RelationshipsPersonSummary,
} from "../../../api/client-types-relationships";
import {
  buildRelationshipsGraphQuery,
  evidenceSummary,
  personLabel,
  platformOptions,
  profilePrimaryValue,
  profileSourceLabel,
  sortPeople,
  summarizeHandles,
  topContacts,
} from "./relationships-utils.ts";

function person(
  overrides: Partial<RelationshipsPersonSummary> = {},
): RelationshipsPersonSummary {
  return {
    displayName: "Person",
    isOwner: false,
    relationshipCount: 0,
    platforms: [],
    identities: [],
    memberEntityIds: [],
    ...overrides,
  } as RelationshipsPersonSummary;
}

const names = (people: RelationshipsPersonSummary[]) =>
  people.map((entry) => entry.displayName);

describe("buildRelationshipsGraphQuery", () => {
  it("trims the search term and drops an empty one", () => {
    expect(buildRelationshipsGraphQuery("  ada  ", "all")).toEqual({
      search: "ada",
      platform: undefined,
      limit: 200,
    });
    expect(buildRelationshipsGraphQuery("   ", "all").search).toBeUndefined();
  });

  it("treats the 'all' platform as no platform filter", () => {
    expect(buildRelationshipsGraphQuery("", "all").platform).toBeUndefined();
    expect(buildRelationshipsGraphQuery("", "discord").platform).toBe(
      "discord",
    );
  });

  it("honours an explicit limit", () => {
    expect(buildRelationshipsGraphQuery("", "all", 25).limit).toBe(25);
  });
});

describe("sortPeople", () => {
  it("puts the owner first regardless of other keys", () => {
    const sorted = sortPeople([
      person({
        displayName: "recent",
        lastInteractionAt: "2026-05-01T00:00:00Z",
      }),
      person({ displayName: "owner", isOwner: true }),
    ]);
    expect(names(sorted)[0]).toBe("owner");
  });

  it("orders by most recent interaction next", () => {
    expect(
      names(
        sortPeople([
          person({
            displayName: "old",
            lastInteractionAt: "2026-01-01T00:00:00Z",
          }),
          person({
            displayName: "new",
            lastInteractionAt: "2026-05-01T00:00:00Z",
          }),
        ]),
      ),
    ).toEqual(["new", "old"]);
  });

  it("does not let an unparseable or absent date reorder the rest", () => {
    const sorted = names(
      sortPeople([
        person({ displayName: "bad", lastInteractionAt: "not-a-date" }),
        person({
          displayName: "new",
          lastInteractionAt: "2026-05-01T00:00:00Z",
        }),
        person({ displayName: "absent" }),
        person({
          displayName: "old",
          lastInteractionAt: "2026-01-01T00:00:00Z",
        }),
      ]),
    );
    expect(sorted.filter((n) => n === "new" || n === "old")).toEqual([
      "new",
      "old",
    ]);
    expect(sorted).toHaveLength(4);
  });

  it("breaks a recency tie on relationship count, then on name", () => {
    expect(
      names(
        sortPeople([
          person({ displayName: "b", relationshipCount: 1 }),
          person({ displayName: "a", relationshipCount: 1 }),
          person({ displayName: "c", relationshipCount: 5 }),
        ]),
      ),
    ).toEqual(["c", "a", "b"]);
  });

  it("does not mutate the input array", () => {
    const input = [person({ displayName: "b" }), person({ displayName: "a" })];
    sortPeople(input);
    expect(names(input)).toEqual(["b", "a"]);
  });
});

describe("summarizeHandles", () => {
  it("prefixes handles and caps the summary at three", () => {
    const summary = summarizeHandles(
      person({
        identities: [
          { handles: [{ handle: "one" }, { handle: "two" }] },
          { handles: [{ handle: "three" }, { handle: "four" }] },
        ],
      } as Partial<RelationshipsPersonSummary>),
    );
    expect(summary).toBe("@one, @two, @three");
  });

  it("returns an empty string when there are no handles", () => {
    expect(summarizeHandles(person({ identities: [] }))).toBe("");
  });
});

describe("platformOptions", () => {
  it("returns an empty list for a missing snapshot", () => {
    expect(platformOptions(null)).toEqual([]);
  });

  it("de-duplicates, drops blanks, and sorts", () => {
    const snapshot = {
      people: [
        person({ platforms: ["discord", "  ", "telegram"] }),
        person({ platforms: ["discord", "apple"] }),
      ],
    } as RelationshipsGraphSnapshot;
    expect(platformOptions(snapshot)).toEqual(["apple", "discord", "telegram"]);
  });
});

describe("topContacts", () => {
  it("emits only the populated rows, in a fixed order", () => {
    const detail = {
      emails: ["a@example.test"],
      phones: [],
      websites: ["https://example.test"],
      preferredCommunicationChannel: "email",
    } as unknown as RelationshipsPersonDetail;
    expect(topContacts(detail)).toEqual([
      { label: "Email", value: "a@example.test" },
      { label: "Website", value: "https://example.test" },
      { label: "Preferred channel", value: "email" },
    ]);
  });

  it("returns nothing when the person has no contact details", () => {
    expect(
      topContacts({
        emails: [],
        phones: [],
        websites: [],
      } as unknown as RelationshipsPersonDetail),
    ).toEqual([]);
  });
});

describe("profileSourceLabel", () => {
  it("maps the known sources to their display names", () => {
    expect(profileSourceLabel("client_chat")).toBe("App chat");
    expect(profileSourceLabel("elizacloud")).toBe("Eliza Cloud");
    expect(profileSourceLabel("twitter")).toBe("X / Twitter");
  });

  it("title-cases an unknown source and expands underscores", () => {
    expect(profileSourceLabel("google_workspace")).toBe("Google Workspace");
    expect(profileSourceLabel("discord")).toBe("Discord");
  });
});

describe("profilePrimaryValue", () => {
  const detail = (profiles: unknown[]) =>
    ({
      profiles,
      displayName: "Fallback",
    }) as unknown as RelationshipsPersonDetail;

  it("returns null when the source has no profile", () => {
    expect(profilePrimaryValue(detail([]), "discord")).toBeNull();
  });

  it("prefers displayName, then handle, then userId, then the person name", () => {
    expect(
      profilePrimaryValue(
        detail([{ source: "d", displayName: "D", handle: "h" }]),
        "d",
      ),
    ).toBe("D");
    expect(
      profilePrimaryValue(detail([{ source: "d", handle: "h" }]), "d"),
    ).toBe("h");
    expect(
      profilePrimaryValue(detail([{ source: "d", userId: "u" }]), "d"),
    ).toBe("u");
    expect(profilePrimaryValue(detail([{ source: "d" }]), "d")).toBe(
      "Fallback",
    );
  });
});

describe("personLabel", () => {
  it("falls back to the raw entity id without a graph or a match", () => {
    expect(personLabel(null, "e1")).toBe("e1");
    expect(
      personLabel(
        { people: [] } as unknown as RelationshipsGraphSnapshot,
        "e1",
      ),
    ).toBe("e1");
  });

  it("resolves the display name of the person owning the entity", () => {
    const graph = {
      people: [person({ displayName: "Ada", memberEntityIds: ["e1", "e2"] })],
    } as RelationshipsGraphSnapshot;
    expect(personLabel(graph, "e2")).toBe("Ada");
  });
});

describe("evidenceSummary", () => {
  const candidate = (evidence: Record<string, unknown>) =>
    ({ evidence }) as unknown as RelationshipsMergeCandidate;

  it("joins platform, handle, notes, and identity count", () => {
    expect(
      evidenceSummary(
        candidate({
          platform: "discord",
          handle: "ada",
          notes: "same email",
          identityIds: ["a", "b"],
        }),
      ),
    ).toBe("discord:ada · same email · 2 identities");
  });

  it("emits the platform alone when there is no handle", () => {
    expect(evidenceSummary(candidate({ platform: "discord" }))).toBe("discord");
  });

  it("falls back to an explicit no-evidence label", () => {
    expect(evidenceSummary(candidate({}))).toBe("No evidence");
    expect(evidenceSummary(candidate({ identityIds: [] }))).toBe("No evidence");
  });
});
