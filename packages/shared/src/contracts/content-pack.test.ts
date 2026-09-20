/**
 * Exercises content-pack manifest validation with deterministic manifest objects.
 * Invalid roots, individual fields, asset variants and accumulated diagnostics
 * protect the loader boundary without mirroring constants or loader policy.
 */
import { describe, expect, it } from "vitest";
import { validateContentPackManifest } from "./content-pack.js";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "cyberpunk-neon",
    name: "Cyberpunk Neon",
    version: "1.0.0",
    assets: {},
    ...overrides,
  };
}

describe("content-pack manifest", () => {
  it("accepts omitted optional assets", () => {
    expect(validateContentPackManifest(manifest())).toEqual([]);
  });
  it.each(
    [null, undefined, [], "pack.json", 42, true].map((input) => ({ input })),
  )("rejects invalid root $input without field diagnostics", ({ input }) => {
    expect(validateContentPackManifest(input)).toEqual([
      { field: "root", message: "Manifest must be a JSON object" },
    ]);
  });
  it.each([
    ["id", "", "Pack id is required"],
    ["id", "   ", "Pack id is required"],
    ["id", 7, "Pack id is required"],
    ["name", "", "Pack name is required"],
    ["name", " \t ", "Pack name is required"],
    ["version", "", "Pack version is required"],
    ["version", "   ", "Pack version is required"],
  ])("rejects %s = %j", (field, value, message) => {
    expect(validateContentPackManifest(manifest({ [field]: value }))).toEqual([
      { field, message },
    ]);
  });
  it.each(["ab", "cyberpunk-neon", "pack1", "a1-b2-c3"])(
    "accepts id %s",
    (id) => {
      expect(validateContentPackManifest(manifest({ id }))).toEqual([]);
    },
  );
  it.each(["Cyberpunk-Neon", "-abc", "abc-", "a", "a b", " ab "])(
    "rejects malformed id %j",
    (id) => {
      expect(validateContentPackManifest(manifest({ id }))).toEqual([
        {
          field: "id",
          message:
            "Pack id must be kebab-case (lowercase letters, numbers, hyphens)",
        },
      ]);
    },
  );
  it.each([undefined, 42, "no"])(
    "rejects invalid assets %j without nested diagnostics",
    (assets) => {
      expect(validateContentPackManifest(manifest({ assets }))).toEqual([
        { field: "assets", message: "Assets object is required" },
      ]);
    },
  );
  it("retains field diagnostics before rejecting missing assets", () => {
    expect(
      validateContentPackManifest({ id: "", name: "", version: "" }).map(
        (error) => error.field,
      ),
    ).toEqual(["id", "name", "version", "assets"]);
  });
  it("accepts a complete pack with optional assets and documented hex lengths", () => {
    expect(
      validateContentPackManifest(
        manifest({
          author: "elizaOS",
          description: "Neon city pack",
          preview: "preview.png",
          assets: {
            vrm: {
              file: "avatar.vrm.gz",
              slug: "avatar",
              preview: "thumbs/avatar.png",
            },
            background: "bg.png",
            world: "world.json",
            streamOverlay: "overlay/",
            personality: { catchphrase: "hello" },
            colorScheme: {
              accent: "#fff",
              bg: "#ffff",
              card: "#ff00ff",
              border: "#FFFFFF",
              text: "#aabbccdd",
              textMuted: "#ABCDEF12",
              customProperties: { glow: "bright" },
            },
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe("content-pack VRM", () => {
  it("accepts null as absent", () => {
    expect(
      validateContentPackManifest(manifest({ assets: { vrm: null } })),
    ).toEqual([]);
  });
  it.each([{ vrm: "model.vrm" }, { vrm: [] }])(
    "rejects non-object $vrm",
    ({ vrm }) => {
      expect(
        validateContentPackManifest(manifest({ assets: { vrm } })),
      ).toEqual([{ field: "assets.vrm", message: "VRM must be an object" }]);
    },
  );
  it.each([{}, { file: "  ", slug: " " }])(
    "requires file and slug in %j",
    (vrm) => {
      expect(
        validateContentPackManifest(manifest({ assets: { vrm } })),
      ).toEqual([
        { field: "assets.vrm.file", message: "VRM file path is required" },
        { field: "assets.vrm.slug", message: "VRM slug is required" },
      ]);
    },
  );
});

describe("content-pack colors", () => {
  it.each([{ colorScheme: "#ff00ff" }, { colorScheme: [] }])(
    "rejects non-object $colorScheme",
    ({ colorScheme }) => {
      expect(
        validateContentPackManifest(manifest({ assets: { colorScheme } })),
      ).toEqual([
        {
          field: "assets.colorScheme",
          message: "Color scheme must be an object",
        },
      ]);
    },
  );
  it("reports every invalid color with its field path", () => {
    const errors = validateContentPackManifest(
      manifest({
        assets: {
          colorScheme: {
            accent: "orange",
            bg: "black",
            card: "white",
            border: "grey",
            text: "ink",
            textMuted: "dim",
          },
        },
      }),
    );
    expect(errors).toEqual(
      ["accent", "bg", "card", "border", "text", "textMuted"].map((key) => ({
        field: `assets.colorScheme.${key}`,
        message: "Color value must be a valid hex color (e.g. #ff00ff)",
      })),
    );
  });
  it("rejects malformed hex lengths and missing hash prefix", () => {
    expect(
      validateContentPackManifest(
        manifest({
          assets: {
            colorScheme: { accent: "#ff", bg: "ff00ff", text: "#123456789" },
          },
        }),
      ).map((error) => error.field),
    ).toEqual([
      "assets.colorScheme.accent",
      "assets.colorScheme.bg",
      "assets.colorScheme.text",
    ]);
  });
  it("leaves non-string values to the consumer", () => {
    expect(
      validateContentPackManifest(
        manifest({
          assets: { colorScheme: { accent: 16711935, bg: null, card: true } },
        }),
      ),
    ).toEqual([]);
  });
});

it("accumulates independent field and asset diagnostics in order", () => {
  expect(
    validateContentPackManifest(
      manifest({
        id: "Bad_Id",
        name: "",
        version: "",
        assets: { vrm: {}, colorScheme: { accent: "red" } },
      }),
    ).map((error) => error.field),
  ).toEqual([
    "id",
    "name",
    "version",
    "assets.vrm.file",
    "assets.vrm.slug",
    "assets.colorScheme.accent",
  ]);
});
