/**
 * Unit tests for the pure document/knowledge JSONB mappers in
 * `agent-mapping.ts`. These exercise the real `documentsToDb` /
 * `documentsFromDb` round-trip contract that `AgentStore.create` and
 * `AgentStore.get` rely on — no database is involved. The regression under
 * test: a `directory`-case `DocumentSourceItem` was serialized under the
 * `path` key, so on reload `normalizeLegacyDocumentEntry` (which checks `path`
 * before `directory`) silently downgraded it to a `path`-case entry and
 * dropped the `shared` flag. Legacy DB row shapes must keep normalizing.
 */
import type { DocumentSourceItem } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { documentsFromDb, documentsToDb } from "../../agent-mapping";

describe("documents mapper round-trip", () => {
  it("preserves directory discriminant and shared flag through toDb→fromDb", () => {
    const original: DocumentSourceItem[] = [
      { item: { case: "directory", value: { directory: "docs/", shared: true } } },
    ];

    const persisted = documentsToDb(original);
    // Directory items must NOT carry a `path` key, or the reader downgrades them.
    expect(persisted).toEqual([{ directory: "docs/", shared: true }]);

    const reloaded = documentsFromDb(persisted);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].item.case).toBe("directory");
    if (reloaded[0].item.case === "directory") {
      expect(reloaded[0].item.value.directory).toBe("docs/");
      expect(reloaded[0].item.value.shared).toBe(true);
    }
  });

  it("preserves a directory source with shared=false", () => {
    const original: DocumentSourceItem[] = [
      { item: { case: "directory", value: { directory: "kb/", shared: false } } },
    ];

    const reloaded = documentsFromDb(documentsToDb(original));
    expect(reloaded[0].item.case).toBe("directory");
    if (reloaded[0].item.case === "directory") {
      expect(reloaded[0].item.value.directory).toBe("kb/");
      expect(reloaded[0].item.value.shared).toBe(false);
    }
  });

  it("serializes a legacy directory value stored under the `path` alias as a directory", () => {
    // DocumentDirectory allows `path` as an alias for `directory`.
    const original: DocumentSourceItem[] = [
      { item: { case: "directory", value: { path: "aliased/", shared: true } } },
    ];

    const persisted = documentsToDb(original);
    expect(persisted).toEqual([{ directory: "aliased/", shared: true }]);
    expect(documentsFromDb(persisted)[0].item.case).toBe("directory");
  });

  it("round-trips a path source as a bare string", () => {
    const original: DocumentSourceItem[] = [{ item: { case: "path", value: "a.md" } }];

    const persisted = documentsToDb(original);
    expect(persisted).toEqual(["a.md"]);

    const reloaded = documentsFromDb(persisted);
    expect(reloaded[0].item.case).toBe("path");
    if (reloaded[0].item.case === "path") {
      expect(reloaded[0].item.value).toBe("a.md");
    }
  });

  it("normalizes legacy DB row shapes (regression guard)", () => {
    const legacyRows = ["a.md", { path: "x" }, { directory: "y", shared: false }];
    const normalized = documentsFromDb(legacyRows);

    expect(normalized).toHaveLength(3);

    expect(normalized[0].item.case).toBe("path");
    if (normalized[0].item.case === "path") {
      expect(normalized[0].item.value).toBe("a.md");
    }

    expect(normalized[1].item.case).toBe("path");
    if (normalized[1].item.case === "path") {
      expect(normalized[1].item.value).toBe("x");
    }

    expect(normalized[2].item.case).toBe("directory");
    if (normalized[2].item.case === "directory") {
      expect(normalized[2].item.value.directory).toBe("y");
      expect(normalized[2].item.value.shared).toBe(false);
    }
  });

  it("returns an empty array for empty/nullish input", () => {
    expect(documentsToDb(undefined)).toEqual([]);
    expect(documentsToDb(null)).toEqual([]);
    expect(documentsToDb([])).toEqual([]);
    expect(documentsFromDb(undefined)).toEqual([]);
    expect(documentsFromDb([])).toEqual([]);
  });
});
