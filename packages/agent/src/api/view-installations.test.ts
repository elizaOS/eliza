/** Real runtime identities exercise atomic view ownership without shared process fixtures. */
import {
  AgentRuntime,
  createCharacter,
  type ViewDeclaration,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  assertViewInstallation,
  beginViewInstallation,
  closeRuntimeViewRegistry,
  commitViewInstallation,
  revokeViewInstallation,
  runtimeViewEntries,
} from "./view-installations.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";

function runtime() {
  return new AgentRuntime({
    character: createCharacter({ name: "Same owner" }),
    enableAutonomy: false,
  });
}
function entry(
  owner: string,
  id: string,
  extra: Partial<ViewDeclaration> = {},
): ViewRegistryEntry {
  return {
    id,
    label: id,
    pluginName: owner,
    viewType: "gui",
    hasHeroImage: false,
    available: true,
    loadedAt: 0,
    platform: "web",
    ...extra,
  };
}

describe("runtime view installation authority", () => {
  it("isolates runtimes with the same agent ID and plugin name", () => {
    const a = runtime();
    const b = runtime();
    expect(a.agentId).toBe(b.agentId);
    const first = beginViewInstallation(a, "notes");
    const second = beginViewInstallation(b, "notes");
    commitViewInstallation(a, first, [entry("notes", "notes")]);
    commitViewInstallation(b, second, [entry("notes", "notes")]);
    expect(() => assertViewInstallation(b, first)).toThrowError(
      expect.objectContaining({ code: "VIEW_INSTALLATION_INVALID" }),
    );
    revokeViewInstallation(a, first);
    expect(runtimeViewEntries(a)).toEqual([]);
    expect(runtimeViewEntries(b).map(({ id }) => id)).toEqual(["notes"]);
    assertViewInstallation(b, second);
  });

  it("does not admit a serialized or copied handle", () => {
    const host = runtime();
    const lease = beginViewInstallation(host, "notes");
    commitViewInstallation(host, lease, [entry("notes", "notes")]);
    expect(() => assertViewInstallation(host, { ...lease })).toThrowError(
      expect.objectContaining({ code: "VIEW_INSTALLATION_INVALID" }),
    );
  });

  it("rejects the entire conflicting installation without disturbing either incumbent", () => {
    const host = runtime();
    const notes = beginViewInstallation(host, "notes");
    const calendar = beginViewInstallation(host, "calendar");
    commitViewInstallation(host, notes, [entry("notes", "notes")]);
    commitViewInstallation(host, calendar, [entry("calendar", "calendar")]);
    const replacement = beginViewInstallation(host, "notes");
    expect(() =>
      commitViewInstallation(host, replacement, [
        entry("notes", "new-note-view"),
        entry("notes", "calendar"),
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "VIEW_REGISTRY_COLLISION" }),
    );
    expect(
      runtimeViewEntries(host)
        .map(({ id }) => id)
        .sort(),
    ).toEqual(["calendar", "notes"]);
    assertViewInstallation(host, notes);
    assertViewInstallation(host, calendar);
  });

  it("revokes pending work before it can publish and preserves a replacement against old cleanup", async () => {
    const host = runtime();
    const old = beginViewInstallation(host, "notes");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = barrier.then(() =>
      commitViewInstallation(host, old, [entry("notes", "old")]),
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: "VIEW_INSTALLATION_INVALID",
    });
    revokeViewInstallation(host, old);
    const replacement = beginViewInstallation(host, "notes");
    commitViewInstallation(host, replacement, [entry("notes", "new")]);
    release();
    await rejected;
    revokeViewInstallation(host, old);
    expect(runtimeViewEntries(host).map(({ id }) => id)).toEqual(["new"]);
    assertViewInstallation(host, replacement);
  });

  it("closing one runtime fences its late completion without closing another", () => {
    const a = runtime();
    const b = runtime();
    const pending = beginViewInstallation(a, "notes");
    const active = beginViewInstallation(b, "notes");
    commitViewInstallation(b, active, [entry("notes", "notes")]);
    closeRuntimeViewRegistry(a);
    closeRuntimeViewRegistry(a);
    expect(() =>
      commitViewInstallation(a, pending, [entry("notes", "notes")]),
    ).toThrowError(expect.objectContaining({ code: "VIEW_REGISTRY_CLOSED" }));
    expect(() => beginViewInstallation(a, "notes")).toThrowError(
      expect.objectContaining({ code: "VIEW_REGISTRY_CLOSED" }),
    );
    assertViewInstallation(b, active);
  });
});
