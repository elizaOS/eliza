/**
 * Pins the extra settings-group registry. Its store lives on a `Symbol.for`
 * key so every bundle in the process shares one list, which means the registry
 * is realm-global state: these cases save and restore it rather than assuming a
 * clean slate. Covers last-write-wins, order-based listing, defensive copying,
 * and the pinned group-id constants. No DOM, no runtime.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLOUD_SETTINGS_GROUP_ID,
  DEVELOPER_SETTINGS_GROUP_ID,
  type ExtraSettingsGroupDef,
  getExtraSettingsGroup,
  listExtraSettingsGroups,
  registerSettingsGroup,
} from "./cloud-settings-group";

const STORE_KEY = Symbol.for("elizaos.ui.cloud-settings-group-registry");

type Store = { groups: Map<string, ExtraSettingsGroupDef> };

function store(): Store | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[STORE_KEY] as
    | Store
    | undefined;
}

let saved: Array<[string, ExtraSettingsGroupDef]> = [];

beforeEach(() => {
  saved = [...(store()?.groups ?? new Map())];
  store()?.groups.clear();
});

afterEach(() => {
  const current = store();
  if (!current) return;
  current.groups.clear();
  for (const [id, def] of saved) current.groups.set(id, def);
});

const group = (
  id: string,
  order: number,
  label = `Label ${id}`,
): ExtraSettingsGroupDef => ({ id, label, order });

describe("registerSettingsGroup", () => {
  it("makes a group retrievable by id", () => {
    registerSettingsGroup(group("alpha", 1));
    expect(getExtraSettingsGroup("alpha")).toEqual(group("alpha", 1));
  });

  it("last write for an id wins", () => {
    registerSettingsGroup(group("alpha", 1, "First"));
    registerSettingsGroup(group("alpha", 9, "Second"));
    expect(getExtraSettingsGroup("alpha")).toEqual({
      id: "alpha",
      label: "Second",
      order: 9,
    });
    expect(listExtraSettingsGroups()).toHaveLength(1);
  });

  it("stores a copy, so mutating the caller's object does not leak in", () => {
    const def = group("alpha", 1);
    registerSettingsGroup(def);
    def.label = "mutated";
    def.order = 99;
    expect(getExtraSettingsGroup("alpha")).toEqual(group("alpha", 1));
  });

  it("keeps distinct ids separate", () => {
    registerSettingsGroup(group("alpha", 1));
    registerSettingsGroup(group("beta", 2));
    expect(listExtraSettingsGroups().map((g) => g.id)).toEqual([
      "alpha",
      "beta",
    ]);
  });
});

describe("getExtraSettingsGroup", () => {
  it("returns undefined for an unregistered id", () => {
    expect(getExtraSettingsGroup("nope")).toBeUndefined();
  });

  it("returns undefined for inherited Object.prototype keys", () => {
    for (const key of [
      "toString",
      "constructor",
      "hasOwnProperty",
      "__proto__",
    ]) {
      expect(getExtraSettingsGroup(key)).toBeUndefined();
    }
  });

  it("is exact — no trimming or case folding", () => {
    registerSettingsGroup(group("alpha", 1));
    for (const key of ["Alpha", "ALPHA", " alpha", "alpha "]) {
      expect(getExtraSettingsGroup(key)).toBeUndefined();
    }
  });
});

describe("listExtraSettingsGroups", () => {
  it("is empty when nothing is registered", () => {
    expect(listExtraSettingsGroups()).toEqual([]);
  });

  it("sorts by order, not by insertion or id", () => {
    registerSettingsGroup(group("zeta", 3));
    registerSettingsGroup(group("alpha", 1));
    registerSettingsGroup(group("mid", 2));
    expect(listExtraSettingsGroups().map((g) => g.id)).toEqual([
      "alpha",
      "mid",
      "zeta",
    ]);
  });

  it("supports fractional orders that interleave with the built-in slots", () => {
    // Built-ins occupy 0 (agent), 1 (system), 2 (security); 1.5 sits between.
    registerSettingsGroup(group("security-ish", 2.5));
    registerSettingsGroup(group("cloud", 1.5));
    expect(listExtraSettingsGroups().map((g) => g.order)).toEqual([1.5, 2.5]);
  });

  it("supports negative orders sorting ahead of everything", () => {
    registerSettingsGroup(group("late", 5));
    registerSettingsGroup(group("early", -1));
    expect(listExtraSettingsGroups()[0]?.id).toBe("early");
  });

  it("keeps registration order among equal orders", () => {
    registerSettingsGroup(group("first", 1));
    registerSettingsGroup(group("second", 1));
    registerSettingsGroup(group("third", 1));
    expect(listExtraSettingsGroups().map((g) => g.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("returns a fresh array that callers cannot use to corrupt the registry", () => {
    registerSettingsGroup(group("alpha", 1));
    const listed = listExtraSettingsGroups();
    listed.push(group("injected", 0));
    listed.reverse();
    expect(listExtraSettingsGroups().map((g) => g.id)).toEqual(["alpha"]);
  });

  it("reflects a re-registration in the new position", () => {
    registerSettingsGroup(group("alpha", 5));
    registerSettingsGroup(group("beta", 1));
    expect(listExtraSettingsGroups().map((g) => g.id)).toEqual([
      "beta",
      "alpha",
    ]);
    registerSettingsGroup(group("alpha", 0));
    expect(listExtraSettingsGroups().map((g) => g.id)).toEqual([
      "alpha",
      "beta",
    ]);
  });
});

describe("pinned group ids", () => {
  it("are stable, distinct, non-empty slugs", () => {
    expect(CLOUD_SETTINGS_GROUP_ID).toBe("cloud");
    expect(DEVELOPER_SETTINGS_GROUP_ID).toBe("developer");
    expect(CLOUD_SETTINGS_GROUP_ID).not.toBe(DEVELOPER_SETTINGS_GROUP_ID);
    for (const id of [CLOUD_SETTINGS_GROUP_ID, DEVELOPER_SETTINGS_GROUP_ID]) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("do not collide with the pinned built-in group ids", () => {
    for (const builtin of ["agent", "system", "security"]) {
      expect(CLOUD_SETTINGS_GROUP_ID).not.toBe(builtin);
      expect(DEVELOPER_SETTINGS_GROUP_ID).not.toBe(builtin);
    }
  });
});

describe("shared store identity", () => {
  it("registers into the Symbol.for store every bundle reads", () => {
    registerSettingsGroup(group("alpha", 1));
    expect(store()?.groups.get("alpha")).toEqual(group("alpha", 1));
  });
});
