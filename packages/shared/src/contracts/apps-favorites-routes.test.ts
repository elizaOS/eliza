import { describe, expect, it } from "vitest";
import {
  FavoritesResponseSchema,
  PostReplaceFavoritesRequestSchema,
  PutFavoriteAppRequestSchema,
} from "./apps-favorites-routes.js";

describe("PutFavoriteAppRequestSchema", () => {
  it("accepts a string + bool pair", () => {
    const parsed = PutFavoriteAppRequestSchema.parse({
      appName: "companion",
      isFavorite: true,
    });
    expect(parsed).toEqual({ appName: "companion", isFavorite: true });
  });

  it("trims appName whitespace", () => {
    const parsed = PutFavoriteAppRequestSchema.parse({
      appName: "  companion  ",
      isFavorite: false,
    });
    expect(parsed.appName).toBe("companion");
  });

  it("rejects missing appName", () => {
    expect(() =>
      PutFavoriteAppRequestSchema.parse({ isFavorite: true }),
    ).toThrow();
  });

  it("rejects empty appName", () => {
    expect(() =>
      PutFavoriteAppRequestSchema.parse({ appName: "", isFavorite: true }),
    ).toThrow(/required/);
  });

  it("rejects non-boolean isFavorite", () => {
    expect(() =>
      PutFavoriteAppRequestSchema.parse({ appName: "x", isFavorite: "yes" }),
    ).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PutFavoriteAppRequestSchema.parse({
        appName: "x",
        isFavorite: true,
        when: 0,
      }),
    ).toThrow();
  });
});

describe("PostReplaceFavoritesRequestSchema", () => {
  it("accepts an empty array", () => {
    const parsed = PostReplaceFavoritesRequestSchema.parse({
      favoriteAppNames: [],
    });
    expect(parsed.favoriteAppNames).toEqual([]);
  });

  it("accepts a populated string array", () => {
    const parsed = PostReplaceFavoritesRequestSchema.parse({
      favoriteAppNames: ["companion", "phone"],
    });
    expect(parsed.favoriteAppNames).toEqual(["companion", "phone"]);
  });

  it("rejects a non-array favoriteAppNames", () => {
    expect(() =>
      PostReplaceFavoritesRequestSchema.parse({
        favoriteAppNames: "companion",
      }),
    ).toThrow();
  });

  it("rejects non-string elements", () => {
    expect(() =>
      PostReplaceFavoritesRequestSchema.parse({
        favoriteAppNames: ["companion", 42],
      }),
    ).toThrow();
  });

  it("rejects extra fields (strict)", () => {
    expect(() =>
      PostReplaceFavoritesRequestSchema.parse({
        favoriteAppNames: [],
        scope: "user",
      }),
    ).toThrow();
  });
});

describe("FavoritesResponseSchema", () => {
  it("accepts the standard shape", () => {
    const parsed = FavoritesResponseSchema.parse({
      favoriteApps: ["a", "b"],
    });
    expect(parsed.favoriteApps).toEqual(["a", "b"]);
  });

  it("accepts an empty list", () => {
    const parsed = FavoritesResponseSchema.parse({ favoriteApps: [] });
    expect(parsed.favoriteApps).toEqual([]);
  });

  it("rejects non-string elements", () => {
    expect(() =>
      FavoritesResponseSchema.parse({ favoriteApps: ["a", 1] }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      FavoritesResponseSchema.parse({ favoriteApps: [], extra: 1 }),
    ).toThrow();
  });
});
