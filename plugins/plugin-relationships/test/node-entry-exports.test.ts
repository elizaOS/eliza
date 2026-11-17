/**
 * The mobile agent bundle aliases `@elizaos/plugin-relationships` to
 * `src/index.node.ts`. A value a runtime consumer imports from the package but
 * the node entry does not export is bundled as an undefined binding, and the
 * first call throws a ReferenceError on the phone (a contact save failed with
 * "foldIdentity4 is not defined"). Every runtime import must resolve from the
 * node entry.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as nodeEntry from "../src/index.node.ts";

const plugins = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Runtime sources only: tests and renderer components are not in the agent bundle. */
function runtimeSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory())
      return ["node_modules", "dist", "components", "test"].includes(entry.name)
        ? []
        : runtimeSources(file);
    return /\.ts$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name)
      ? [file]
      : [];
  });
}

/** Value names a source imports or re-exports from the package. */
function valueNames(source: string): string[] {
  const names: string[] = [];
  const statement =
    /(import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*"@elizaos\/plugin-relationships"/g;
  for (const match of source.matchAll(statement)) {
    if (match[2]) continue;
    for (const part of match[3].split(",")) {
      const name = part.trim();
      if (!name || name.startsWith("type ")) continue;
      names.push(name.split(/\s+as\s+/)[0]);
    }
  }
  return names;
}

describe("plugin-relationships node entry", () => {
  it("exports the identity-merge engine", () => {
    expect(
      nodeEntry.foldIdentity([], {
        platform: "phone",
        handle: "+15555550100",
        verified: true,
        confidence: 1,
        addedAt: "2026-01-01T00:00:00.000Z",
        addedVia: "user_chat",
        evidence: [],
      }),
    ).toHaveLength(1);
    for (const name of [
      "AUTO_MERGE_CONFIDENCE_THRESHOLD",
      "OVERRIDE_CONFIDENCE_DELTA",
      "decideIdentityOutcome",
      "findIdentityMatches",
      "mergeEntities",
    ])
      expect(nodeEntry).toHaveProperty(name);
  });

  it("exports every value the personal-assistant runtime imports from the package", () => {
    const missing = new Map<string, string[]>();
    for (const file of runtimeSources(
      path.join(plugins, "plugin-personal-assistant/src"),
    ))
      for (const name of valueNames(readFileSync(file, "utf8")))
        if (!(name in nodeEntry))
          missing.set(name, [
            ...(missing.get(name) ?? []),
            path.relative(plugins, file),
          ]);
    expect(Object.fromEntries(missing)).toEqual({});
  });
});
