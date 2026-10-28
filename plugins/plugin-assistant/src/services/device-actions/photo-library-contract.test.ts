import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  describeLibraryOperation,
  isLibraryId,
  LIBRARY_APP_NAME,
  LIBRARY_LIMITS,
  type LibraryCatalog,
  type LibraryItem,
  LibraryRevisions,
  libraryKindOf,
  MODEL_REVISION,
  modelItem,
  prepareReview,
  reviewCurrent,
  reviewText,
  scopePresentation,
  validateLibraryOperation,
} from "./photo-library-contract";

const scope = (extra: Record<string, unknown> = {}) => ({
  scope: "full" as const,
  images: true,
  videos: true,
  canSelectMore: false,
  canEditOthers: true,
  locked: false,
  version: "v1",
  ...extra,
});

describe("photo library contract", () => {
  it("names the host app in owner-facing text and carries no product name itself", () => {
    const source = readFileSync(
      new URL("./photo-library-contract.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/Alpha/);
    expect(LIBRARY_APP_NAME).toBe("the app");
    expect(scopePresentation(scope()).detail).toMatch(
      /^The app can read the photos and videos Android shows/,
    );
    expect(scopePresentation(scope(), "Example").detail).toMatch(
      /^Example can read .* not visible to Example\.$/,
    );
    expect(
      scopePresentation(scope({ scope: "denied" }), "Example").detail,
    ).toBe(
      "Example cannot read your photo library. Captures you make in Example and items you pick are still available.",
    );
    expect(reviewText("delete", 2, "Example").detail).toMatch(
      /cannot be undone by Example\.$/,
    );
    expect(
      describeLibraryOperation(
        { type: "photo_library_search", kind: "video" },
        "Example",
      ).description,
    ).toMatch(/videos Android lets Example read\. The agent receives ids/);
  });

  it("presents only what Android granted", () => {
    expect(scopePresentation(undefined).label).toBe("Unavailable");
    expect(scopePresentation(scope({ locked: true })).label).toBe("Locked");
    expect(
      scopePresentation(scope({ scope: "selected", canSelectMore: true }))
        .actionKind,
    ).toBe("request");
    expect(
      scopePresentation(scope({ scope: "denied", settingsRequired: true }))
        .actionKind,
    ).toBe("settings");
    expect(scopePresentation(scope({ images: false })).detail).toContain(
      "Photos are not allowed.",
    );
  });

  it("freezes exactly the reviewed revisions and expires the review", () => {
    const items = [{ id: "lib:i:1:10", revision: "1700000001:1001:1" }];
    const review = prepareReview("trash", items, 1000, () => "review-1");
    expect(review).toMatchObject({
      id: "review-1",
      action: "trash",
      items,
      title: "Move 1 item to trash?",
    });
    expect(review.items[0]).not.toBe(items[0]);
    const catalog = { items: [] } as unknown as LibraryCatalog;
    expect(reviewCurrent(review, catalog, review.expiresAt)).toBe(false);
    expect(reviewCurrent(undefined, catalog, 0)).toBe(false);
    expect(() => prepareReview("delete", items)).toThrow(
      "Unsupported library action",
    );
    expect(() => prepareReview("share", [...items, { ...items[0] }])).toThrow(
      "Invalid reviewed item",
    );
    expect(() =>
      prepareReview(
        "share",
        Array.from({ length: LIBRARY_LIMITS.action + 1 }, (_, i) => ({
          id: `lib:i:${i + 1}:${i}`,
          revision: "1:1",
        })),
      ),
    ).toThrow("Select 1–20 items");
    expect(() =>
      prepareReview("share", [{ id: "../x", revision: "1:1" }]),
    ).toThrow("Invalid reviewed item");
  });

  it("accepts only library ids from permitted volumes", () => {
    expect(isLibraryId("lib:i:12:120")).toBe(true);
    expect(isLibraryId("m:external_primary:v:7")).toBe(true);
    expect(libraryKindOf("m:external_primary:v:7")).toBe("video");
    expect(isLibraryId("m:external:i:7")).toBe(false);
    expect(isLibraryId("content://media/external/images/media/7")).toBe(false);
  });

  it("validates agent operations field by field", () => {
    expect(
      validateLibraryOperation({ type: "photo_library_search", kind: "image" }),
    ).toEqual({ type: "photo_library_search", kind: "image" });
    expect(() =>
      validateLibraryOperation({ type: "photo_library_search", query: "x" }),
    ).toThrow("Unexpected library operation field");
    expect(() =>
      validateLibraryOperation({ type: "photo_library_search", kind: "raw" }),
    ).toThrow("Invalid library kind");
    expect(() =>
      validateLibraryOperation({ type: "photo_library_search", from: -1 }),
    ).toThrow("Invalid library date");
  });

  it("gives a model opaque revisions and no names, sizes or locations", () => {
    const revisions = new LibraryRevisions("s1");
    const item: LibraryItem = {
      id: "lib:i:3:30",
      revision: "1700000003:1003:3",
      kind: "image",
      mime: "image/jpeg",
      name: "IMG_3.jpg",
      album: "Camera",
      width: 4000,
      height: 3000,
      takenAt: 1700000003000,
      modifiedAt: 1700000003000,
      size: 123456,
      duration: 0,
      favorite: true,
      owned: false,
    };
    const model = modelItem(item, revisions);
    expect(Object.keys(model).sort()).toEqual(
      [
        "favorite",
        "height",
        "id",
        "kind",
        "revision",
        "takenAt",
        "width",
      ].sort(),
    );
    expect(model.revision).toMatch(MODEL_REVISION);
    expect(revisions.native(item.id, model.revision)).toBe(item.revision);
    expect(revisions.native(item.id, "rev-s1-999")).toBeUndefined();
  });
});
