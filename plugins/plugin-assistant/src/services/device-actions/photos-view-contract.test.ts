import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  deviceOperationSupportedByCapabilities,
  validateDeviceOperation,
} from "./contract";
import {
  LIBRARY_LIMITS,
  PHOTO_LIBRARY_CAPABILITY,
} from "./photo-library-contract";
import {
  describePhotosViewOperation,
  isPhotosViewOperation,
  PHOTOS_FILTER_ALBUMS,
  PHOTOS_SHARE_MAX,
  PHOTOS_VIEW_CAPABILITY,
  PHOTOS_VIEW_DIRECT_TYPES,
  PHOTOS_VIEW_TYPES,
  photosViewContextAllowed,
  validatePhotosViewOperation,
  validatePhotosViewResult,
} from "./photos-view-contract";

const id = (n: number, kind = "i") => `lib:${kind}:${n}:${n * 10}`;
const ids = (count: number) =>
  Array.from({ length: count }, (_, i) => id(i + 1));
const valid = validatePhotosViewOperation;
const invalid = (value: unknown) => () => validatePhotosViewOperation(value);

describe("photos view contract", () => {
  it("carries no product name", () => {
    const source = readFileSync(
      new URL("./photos-view-contract.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/Alpha/);
  });

  it("recognises exactly the Photos view operation types", () => {
    expect([...PHOTOS_VIEW_TYPES]).toEqual([
      "photos_filter",
      "photos_open",
      "photos_album_create",
      "photos_share",
    ]);
    expect([...PHOTOS_VIEW_DIRECT_TYPES]).toEqual([
      "photos_filter",
      "photos_open",
    ]);
    expect([...PHOTOS_FILTER_ALBUMS]).toEqual([
      "favorites",
      "videos",
      "camera",
      "screenshots",
    ]);
    for (const type of PHOTOS_VIEW_TYPES)
      expect(isPhotosViewOperation({ type })).toBe(true);
    for (const type of ["photo_library_select", "photos_trash", "x"])
      expect(isPhotosViewOperation({ type })).toBe(false);
    expect(isPhotosViewOperation(null)).toBe(false);
    expect(invalid({ type: "photos_trash", ids: [id(1)] })).toThrow(
      "Unsupported Photos operation",
    );
    expect(invalid([])).toThrow("Invalid Photos operation");
  });

  it("validates photos_filter", () => {
    expect(valid({ type: "photos_filter" })).toEqual({ type: "photos_filter" });
    const full = {
      type: "photos_filter",
      from: 0,
      to: 1_700_000_000_000,
      kind: "video",
      favorite: false,
      album: "custom:trip_2026-a",
      text: "beach",
    };
    expect(valid(full)).toEqual(full);
    for (const album of PHOTOS_FILTER_ALBUMS)
      expect(valid({ type: "photos_filter", album })).toEqual({
        type: "photos_filter",
        album,
      });
    expect(
      valid({ type: "photos_filter", text: "x".repeat(LIBRARY_LIMITS.query) }),
    ).toEqual({
      type: "photos_filter",
      text: "x".repeat(LIBRARY_LIMITS.query),
    });
    for (const from of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1, Number.NaN])
      expect(invalid({ type: "photos_filter", from })).toThrow(
        "Invalid filter date",
      );
    expect(invalid({ type: "photos_filter", from: 2, to: 1 })).toThrow(
      "Invalid filter date range",
    );
    expect(invalid({ type: "photos_filter", kind: "all" })).toThrow(
      "Invalid filter kind",
    );
    expect(invalid({ type: "photos_filter", favorite: "yes" })).toThrow(
      "Invalid favorites filter",
    );
    for (const album of [
      "Favorites",
      "custom:",
      "custom:a b",
      `custom:${"a".repeat(81)}`,
      3,
    ])
      expect(invalid({ type: "photos_filter", album })).toThrow(
        "Invalid filter album",
      );
    for (const text of [
      "x".repeat(LIBRARY_LIMITS.query + 1),
      "a\nb",
      "a\u007f",
      7,
    ])
      expect(invalid({ type: "photos_filter", text })).toThrow(
        "Invalid filter text",
      );
    expect(invalid({ type: "photos_filter", favorites: true })).toThrow(
      "Unexpected Photos field",
    );
  });

  it("validates photos_open", () => {
    expect(valid({ type: "photos_open", id: id(4, "v") })).toEqual({
      type: "photos_open",
      id: id(4, "v"),
    });
    for (const bad of ["4", "lib:x:1:1", "m:external:i:1", undefined])
      expect(invalid({ type: "photos_open", id: bad })).toThrow(
        "Invalid library id",
      );
    expect(invalid({ type: "photos_open", id: id(1), ids: [] })).toThrow(
      "Unexpected Photos field",
    );
  });

  it("validates photos_album_create without truncating", () => {
    expect(
      valid({ type: "photos_album_create", name: "  Trip  ", ids: [id(1)] }),
    ).toEqual({ type: "photos_album_create", name: "Trip", ids: [id(1)] });
    expect(
      valid({ type: "photos_album_create", name: "a".repeat(80), ids: ids(2) })
        .name,
    ).toBe("a".repeat(80));
    expect(
      valid({
        type: "photos_album_create",
        name: "All",
        ids: ids(LIBRARY_LIMITS.kept),
      }).ids,
    ).toHaveLength(LIBRARY_LIMITS.kept);
    for (const name of ["", "   ", "a".repeat(81), "a\tb", 1, undefined])
      expect(
        invalid({ type: "photos_album_create", name, ids: [id(1)] }),
      ).toThrow("Choose an album name between 1 and 80 characters");
    for (const bad of [
      [],
      [id(1), id(1)],
      ["x"],
      ids(LIBRARY_LIMITS.kept + 1),
      "x",
    ])
      expect(
        invalid({ type: "photos_album_create", name: "Trip", ids: bad }),
      ).toThrow("Invalid album items");
    expect(
      invalid({
        type: "photos_album_create",
        name: "Trip",
        ids: [id(1)],
        id: "a",
      }),
    ).toThrow("Unexpected Photos field");
  });

  it("validates photos_share", () => {
    expect(valid({ type: "photos_share", ids: [id(1), id(2, "v")] })).toEqual({
      type: "photos_share",
      ids: [id(1), id(2, "v")],
    });
    expect(
      valid({ type: "photos_share", ids: ids(PHOTOS_SHARE_MAX) }).ids,
    ).toHaveLength(100);
    for (const bad of [[], [id(1), id(1)], ["x"], ids(PHOTOS_SHARE_MAX + 1)])
      expect(invalid({ type: "photos_share", ids: bad })).toThrow(
        "Invalid share items",
      );
    expect(
      invalid({ type: "photos_share", ids: [id(1)], target: "mail" }),
    ).toThrow("Unexpected Photos field");
  });

  it("is admitted by the device contract and wraps its errors", () => {
    expect(validateDeviceOperation({ type: "photos_open", id: id(1) })).toEqual(
      { type: "photos_open", id: id(1) },
    );
    expect(() =>
      validateDeviceOperation({ type: "photos_share", ids: [] }),
    ).toThrow("Invalid Photos operation: Invalid share items");
  });

  it("is offered only when both photos.library.v1 and photos.view.v1 were negotiated", () => {
    expect(PHOTOS_VIEW_CAPABILITY).toBe("photos.view.v1");
    const both = [PHOTO_LIBRARY_CAPABILITY, PHOTOS_VIEW_CAPABILITY];
    for (const type of PHOTOS_VIEW_TYPES) {
      expect(deviceOperationSupportedByCapabilities(type, both)).toBe(true);
      expect(
        deviceOperationSupportedByCapabilities(type, [
          PHOTO_LIBRARY_CAPABILITY,
        ]),
      ).toBe(false);
      expect(
        deviceOperationSupportedByCapabilities(type, [PHOTOS_VIEW_CAPABILITY]),
      ).toBe(false);
      expect(deviceOperationSupportedByCapabilities(type, [])).toBe(false);
      expect(deviceOperationSupportedByCapabilities(type, undefined)).toBe(
        false,
      );
    }
    // The capability does not widen unrelated operations.
    expect(deviceOperationSupportedByCapabilities("notes_query", both)).toBe(
      false,
    );
  });

  it("describes each operation for the review card in short owner-facing text", () => {
    const d = describePhotosViewOperation;
    expect(d({ type: "photos_filter" })).toEqual({
      title: "Filter Photos",
      description: "Everything",
    });
    expect(
      d({
        type: "photos_filter",
        kind: "video",
        favorite: true,
        album: "camera",
        text: "beach",
        from: 1,
      }),
    ).toEqual({
      title: "Filter Photos",
      description:
        "Videos · Favorites · In Camera · “beach” · In the requested dates",
    });
    expect(d({ type: "photos_filter", album: "custom:a1" }).description).toBe(
      "In an album",
    );
    expect(d({ type: "photos_open", id: id(1) })).toEqual({
      title: "Open photo",
      description: "",
    });
    expect(d({ type: "photos_open", id: id(1, "v") }).title).toBe("Open video");
    expect(
      d({ type: "photos_album_create", name: "Trip", ids: [id(1), id(2)] }),
    ).toEqual({
      title: "Create album “Trip”",
      description: "2 items",
    });
    expect(d({ type: "photos_share", ids: [id(1)] }, "Eliza")).toEqual({
      title: "Share 1 item",
      description: "Android share sheet",
    });
  });

  it("validates results without accepting extra fields", () => {
    const filter = { type: "photos_filter" } as const;
    expect(
      validatePhotosViewResult(filter, {
        kind: "photos_filter",
        shown: 0,
        more: false,
      }),
    ).toEqual({ kind: "photos_filter", shown: 0, more: false });
    for (const bad of [
      { kind: "photos_filter", shown: -1, more: false },
      { kind: "photos_filter", shown: 1.5, more: false },
      { kind: "photos_filter", shown: 1 },
      { kind: "photos_filter", shown: 1, more: true, items: [] },
      { kind: "photos_open", opened: true },
      null,
    ])
      expect(() => validatePhotosViewResult(filter, bad)).toThrow();
    const open = { type: "photos_open", id: id(1) } as const;
    expect(
      validatePhotosViewResult(open, { kind: "photos_open", opened: false }),
    ).toEqual({ kind: "photos_open", opened: false });
    expect(() =>
      validatePhotosViewResult(open, { kind: "photos_open", opened: 1 }),
    ).toThrow("Invalid photos open result");
    for (const op of [
      { type: "photos_album_create", name: "Trip", ids: [id(1), id(2)] },
      { type: "photos_share", ids: [id(1), id(2)] },
    ] as const) {
      const row = {
        kind: op.type,
        status: "review_opened",
        count: 1,
        missing: 1,
      };
      expect(validatePhotosViewResult(op, row)).toEqual(row);
      for (const bad of [
        { ...row, count: 0, missing: 2 },
        { ...row, count: 2, missing: 1 },
        { ...row, status: "done" },
        { ...row, ids: [] },
      ])
        expect(() => validatePhotosViewResult(op, bad)).toThrow();
    }
  });

  it("allows review only in Photos on the unlocked phone", () => {
    expect(photosViewContextAllowed({ view: "photos" })).toBe(true);
    expect(photosViewContextAllowed({ view: "photos", sensitive: true })).toBe(
      false,
    );
    expect(photosViewContextAllowed({ view: "home" })).toBe(false);
  });
});
