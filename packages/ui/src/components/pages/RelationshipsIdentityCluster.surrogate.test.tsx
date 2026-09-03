/**
 * Surrogate-safe truncation for RelationshipsIdentityCluster labels.
 */
// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RelationshipsPersonDetail } from "../../api/client-types-relationships";
import { RelationshipsIdentityCluster } from "./RelationshipsIdentityCluster";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function naiveShortLabel(value: string, maxLength = 18): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 1)}\u2026`
    : value;
}

function makePerson(
  overrides: Partial<{
    platform: string;
    name: string;
    handle: string;
  }>,
): RelationshipsPersonDetail {
  const platform = overrides.platform ?? "test_platform";
  const person: RelationshipsPersonDetail = {
    groupId: "person-1",
    primaryEntityId: "entity-1",
    memberEntityIds: ["entity-1"],
    displayName: "Test",
    aliases: [],
    platforms: [platform],
    identities: [
      {
        entityId: "entity-1",
        platforms: [platform],
        names: overrides.name ? [overrides.name] : [],
        handles: overrides.handle
          ? [{ entityId: "entity-1", platform, handle: overrides.handle }]
          : [],
      },
    ],
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
    facts: [],
    recentConversations: [],
    relevantMemories: [],
    relationships: [],
    identityEdges: [],
    userPersonalityPreferences: [],
  };
  return person;
}

afterEach(() => cleanup());

describe("RelationshipsIdentityCluster surrogate-safe", () => {
  it("preserves well-formed Unicode when platform label straddles truncation (max 12)", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    // 10 "a" + fox (2 units at indices 10,11) -> slice(0,11) lands on high surrogate -> ill-formed naive
    const platform = `${"a".repeat(10)}${fox}extra-chars`;
    const naive = naiveShortLabel(platform.replace(/_/g, " "), 12);
    expect(isWellFormed(naive)).toBe(false);

    const person = makePerson({ platform, name: "Alice", handle: "alice" });
    const { container } = render(
      <RelationshipsIdentityCluster person={person} />,
    );
    const text = container.textContent ?? "";
    expect(isWellFormed(text)).toBe(true);
    expect(() => JSON.stringify(text)).not.toThrow();
  });

  it("preserves well-formed when primary name straddles 28 boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    // 26 "a" + fox -> 26 at 0-25, fox at 26,27, tail at 28+ -> slice(0,27) keeps high surrogate
    const name = `${"a".repeat(26)}${fox}tail-which-pushes-over-max`;
    const naive = naiveShortLabel(name, 28);
    expect(isWellFormed(naive)).toBe(false);

    const person = makePerson({ platform: "test", name, handle: "handle" });
    const { container } = render(
      <RelationshipsIdentityCluster person={person} />,
    );
    const text = container.textContent ?? "";
    expect(isWellFormed(text)).toBe(true);
  });

  it("preserves well-formed when detail/handle straddles 32 boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    // 30 "b" + fox -> fox at 30,31 -> slice(0,31) -> lone high
    const handle = `${"b".repeat(30)}${fox}extra-chars-beyond-limit`;
    const naive = naiveShortLabel(handle, 32);
    expect(isWellFormed(naive)).toBe(false);

    const person = makePerson({ platform: "test", name: "Bob", handle });
    const { container } = render(
      <RelationshipsIdentityCluster person={person} />,
    );
    const text = container.textContent ?? "";
    expect(isWellFormed(text)).toBe(true);
  });

  it("passes short values through unchanged and stays well-formed", () => {
    const person = makePerson({
      platform: "discord",
      name: "Alice",
      handle: "alice_handle",
    });
    const { container } = render(
      <RelationshipsIdentityCluster person={person} />,
    );
    expect(container.textContent).toContain("discord");
    expect(container.textContent).toContain("Alice");
    expect(isWellFormed(container.textContent ?? "")).toBe(true);
  });
});
