/**
 * Covers MCP action-name derivation: server/tool to action name, the simile
 * set, parsing back out, collision detection, and uniquification.
 *
 * Action names are the registry keys an agent dispatches on, so the contracts
 * that matter are the identity ones: two tools that normalize to the same name
 * must be reported as colliding, `makeUniqueActionName` must never hand back a
 * name already in the set, and the simile list must never contain the action's
 * own name (which would register an alias pointing at itself).
 *
 * Pure functions — no runtime, no MCP transport.
 */
import { describe, expect, test } from "bun:test";

import {
  actionNamesCollide,
  generateSimiles,
  makeUniqueActionName,
  parseActionName,
  toActionName,
} from "./action-naming";

describe("toActionName", () => {
  test("upper-cases and joins server and tool", () => {
    expect(toActionName("github", "create issue")).toBe("GITHUB_CREATE_ISSUE");
  });

  test("collapses runs of separators to a single underscore", () => {
    expect(toActionName("my--server", "do..thing")).toBe("MY_SERVER_DO_THING");
  });

  test("strips leading and trailing separators", () => {
    expect(toActionName("__github__", "--create--")).toBe("GITHUB_CREATE");
  });

  test("does not double the server prefix when the tool already carries it", () => {
    expect(toActionName("github", "github_create")).toBe("GITHUB_CREATE");
    expect(toActionName("github", "GitHub Create")).toBe("GITHUB_CREATE");
  });

  test("still prefixes when the tool merely starts with similar text", () => {
    // "GITHUBBER" is not the "GITHUB_" prefix, so it must not be treated as one.
    expect(toActionName("github", "githubber")).toBe("GITHUB_GITHUBBER");
  });

  test("degrades predictably when a side is unusable", () => {
    expect(toActionName("", "create")).toBe("CREATE");
    expect(toActionName("!!!", "create")).toBe("CREATE");
    expect(toActionName("github", "!!!")).toBe("GITHUB_");
    expect(toActionName("", "")).toBe("_");
  });
});

describe("generateSimiles", () => {
  test("never includes the action's own name", () => {
    const fullName = toActionName("github", "create_issue");
    expect(generateSimiles("github", "create_issue")).not.toContain(fullName);
  });

  test("contains no duplicates", () => {
    const similes = generateSimiles("github", "create_issue");
    expect(new Set(similes).size).toBe(similes.length);
  });

  test("includes the bare tool name and both slash forms", () => {
    const similes = generateSimiles("GitHub", "create_issue");
    expect(similes).toContain("CREATE_ISSUE");
    expect(similes).toContain("GitHub/create_issue");
    expect(similes).toContain("github/create_issue");
  });

  test("includes an MCP-prefixed alias", () => {
    expect(generateSimiles("github", "create_issue")).toContain(
      `MCP_${toActionName("github", "create_issue")}`,
    );
  });

  test("adds the reversed form only for a two-part tool name", () => {
    expect(generateSimiles("github", "create_issue")).toContain("ISSUE_CREATE");
    expect(generateSimiles("github", "createissue")).not.toContain("ISSUE_CREATE");
    expect(generateSimiles("github", "a_b_c")).not.toContain("B_A");
  });

  test("does not add a reversed form that equals the tool name", () => {
    const similes = generateSimiles("srv", "same_same");
    expect(similes.filter((s) => s === "SAME_SAME")).toHaveLength(1);
  });
});

describe("parseActionName", () => {
  test("splits at the first underscore and lower-cases both halves", () => {
    expect(parseActionName("GITHUB_CREATE_ISSUE")).toEqual({
      serverName: "github",
      toolName: "create_issue",
    });
  });

  test("returns null when there is no separator", () => {
    expect(parseActionName("GITHUB")).toBeNull();
    expect(parseActionName("")).toBeNull();
    expect(parseActionName("!!!")).toBeNull();
  });

  test("normalizes before splitting, so raw input parses too", () => {
    expect(parseActionName("github create issue")).toEqual({
      serverName: "github",
      toolName: "create_issue",
    });
  });

  test("round-trips a single-token server through toActionName", () => {
    const parsed = parseActionName(toActionName("github", "create issue"));
    expect(parsed).toEqual({ serverName: "github", toolName: "create_issue" });
  });
});

describe("actionNamesCollide", () => {
  test("reports names that differ only by case or separators as colliding", () => {
    expect(actionNamesCollide("GITHUB_CREATE", "github-create")).toBe(true);
    expect(actionNamesCollide("github create", "__GITHUB__CREATE__")).toBe(true);
  });

  test("reports genuinely different names as distinct", () => {
    expect(actionNamesCollide("GITHUB_CREATE", "GITHUB_DELETE")).toBe(false);
  });
});

describe("makeUniqueActionName", () => {
  test("returns the plain name when it is free", () => {
    expect(makeUniqueActionName("github", "create", new Set())).toBe("GITHUB_CREATE");
  });

  test("suffixes from 2 when the plain name is taken", () => {
    expect(makeUniqueActionName("github", "create", new Set(["GITHUB_CREATE"]))).toBe(
      "GITHUB_CREATE_2",
    );
  });

  test("skips over every suffix already in use", () => {
    const existing = new Set(["GITHUB_CREATE", "GITHUB_CREATE_2", "GITHUB_CREATE_3"]);
    expect(makeUniqueActionName("github", "create", existing)).toBe("GITHUB_CREATE_4");
  });

  test("never returns a name already present in the set", () => {
    const existing = new Set(["GITHUB_CREATE", "GITHUB_CREATE_2"]);
    const name = makeUniqueActionName("github", "create", existing);
    expect(existing.has(name)).toBe(false);
  });
});
