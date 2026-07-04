// @vitest-environment jsdom
/**
 * User background catalog (#13538): persistence of agent/user-added backgrounds.
 * Proves only re-hosted /api/media URLs persist (data-URL quota guard) and the
 * store never accepts a non-image / code-bearing entry.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { BackgroundCatalogEntry } from "./ui-preferences";
import {
  addUserBackgroundEntry,
  loadUserBackgroundCatalog,
  MAX_USER_CATALOG_ENTRIES,
} from "./user-background-catalog";

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

function imageEntry(id: string, source: string): BackgroundCatalogEntry {
  return {
    id,
    label: id,
    description: "test",
    kind: "image",
    source,
    mood: "custom",
    palette: ["#123456"],
    tags: ["custom"],
    author: "you",
  };
}

describe("user background catalog (#13538)", () => {
  it("persists a re-hosted /api/media upload and reloads it", () => {
    const next = addUserBackgroundEntry(
      imageEntry("user-1", "/api/media/abc.png"),
    );
    expect(next).toHaveLength(1);
    expect(loadUserBackgroundCatalog()[0].source).toBe("/api/media/abc.png");
  });

  it("REJECTS an inline data: URL (localStorage quota guard)", () => {
    const next = addUserBackgroundEntry(
      imageEntry("user-data", "data:image/png;base64,AAAA"),
    );
    expect(next).toHaveLength(0);
    expect(loadUserBackgroundCatalog()).toHaveLength(0);
  });

  it("rejects a non-image / bogus source", () => {
    expect(
      addUserBackgroundEntry(imageEntry("x", "https://evil.example/x.png")),
    ).toHaveLength(0);
    expect(
      addUserBackgroundEntry({
        ...imageEntry("y", "/api/media/ok.png"),
        kind: "glsl",
        source: "aurora",
      } as BackgroundCatalogEntry),
    ).toHaveLength(0);
  });

  it("updates by id (no duplicate) and keeps newest first", () => {
    addUserBackgroundEntry(imageEntry("a", "/api/media/a1.png"));
    addUserBackgroundEntry(imageEntry("b", "/api/media/b1.png"));
    const list = addUserBackgroundEntry(imageEntry("a", "/api/media/a2.png"));
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("a");
    expect(list[0].source).toBe("/api/media/a2.png");
  });

  it("caps the persisted catalog size", () => {
    for (let i = 0; i < MAX_USER_CATALOG_ENTRIES + 5; i++) {
      addUserBackgroundEntry(imageEntry(`e${i}`, `/api/media/${i}.png`));
    }
    expect(loadUserBackgroundCatalog().length).toBe(MAX_USER_CATALOG_ENTRIES);
  });
});
