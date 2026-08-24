/**
 * Exercises the real validateContentPackManifest validator and the content-pack
 * constants. The suite drives plain manifest objects through the actual module,
 * covering root rejection, required fields, kebab-case id rules, asset shape
 * validation, hex color enforcement, and accumulated error ordering.
 */

import { describe, expect, it } from "vitest";
import {
  CONTENT_PACK_MANIFEST_FILENAME,
  CONTENT_PACK_MAX_SIZE_BYTES,
  validateContentPackManifest,
} from "./content-pack.js";

function validManifest(overrides?: Record<string, unknown>): unknown {
  return {
    id: "cyberpunk-neon",
    name: "Cyberpunk Neon",
    version: "1.0.0",
    assets: {},
    ...overrides,
  };
}

describe("CONTENT_PACK_MANIFEST_FILENAME", () => {
  it("is the pack manifest filename", () => {
    expect(CONTENT_PACK_MANIFEST_FILENAME).toBe("pack.json");
  });
});

describe("CONTENT_PACK_MAX_SIZE_BYTES", () => {
  it("is exactly 100 MB", () => {
    expect(CONTENT_PACK_MAX_SIZE_BYTES).toBe(100 * 1024 * 1024);
  });
});

describe("validateContentPackManifest root checks", () => {
  it("accepts a minimal valid manifest with no errors", () => {
    expect(validateContentPackManifest(validManifest())).toEqual([]);
  });

  it("rejects null with a single root error", () => {
    expect(validateContentPackManifest(null)).toEqual([
      { field: "root", message: "Manifest must be a JSON object" },
    ]);
  });

  it("rejects undefined with a single root error", () => {
    expect(validateContentPackManifest(undefined)).toEqual([
      { field: "root", message: "Manifest must be a JSON object" },
    ]);
  });

  it("rejects arrays with a single root error", () => {
    expect(validateContentPackManifest([validManifest()])).toEqual([
      { field: "root", message: "Manifest must be a JSON object" },
    ]);
  });

  it("rejects primitive values with a single root error", () => {
    for (const data of ["pack.json", 42, true]) {
      expect(validateContentPackManifest(data)).toEqual([
        { field: "root", message: "Manifest must be a JSON object" },
      ]);
    }
  });

  it("stops at the root error without checking any other fields", () => {
    const errors = validateContentPackManifest("nope");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe("root");
  });
});

describe("validateContentPackManifest required fields", () => {
  it("requires id", () => {
    const errors = validateContentPackManifest(validManifest({ id: "" }));
    expect(errors).toContainEqual({
      field: "id",
      message: "Pack id is required",
    });
  });

  it("requires a non-whitespace id", () => {
    const errors = validateContentPackManifest(validManifest({ id: "   " }));
    expect(errors).toContainEqual({
      field: "id",
      message: "Pack id is required",
    });
  });

  it("requires id to be a string", () => {
    const errors = validateContentPackManifest(validManifest({ id: 7 }));
    expect(errors).toContainEqual({
      field: "id",
      message: "Pack id is required",
    });
  });

  it("requires name", () => {
    const errors = validateContentPackManifest(validManifest({ name: "" }));
    expect(errors).toContainEqual({
      field: "name",
      message: "Pack name is required",
    });
  });

  it("requires a non-whitespace name", () => {
    const errors = validateContentPackManifest(validManifest({ name: " \t " }));
    expect(errors).toContainEqual({
      field: "name",
      message: "Pack name is required",
    });
  });

  it("requires version", () => {
    const errors = validateContentPackManifest(validManifest({ version: "" }));
    expect(errors).toContainEqual({
      field: "version",
      message: "Pack version is required",
    });
  });

  it("requires a non-whitespace version", () => {
    const errors = validateContentPackManifest(
      validManifest({ version: "   " }),
    );
    expect(errors).toContainEqual({
      field: "version",
      message: "Pack version is required",
    });
  });
});

describe("validateContentPackManifest pack id format", () => {
  it("accepts lowercase kebab-case ids", () => {
    for (const id of ["ab", "cyberpunk-neon", "pack1", "a1-b2-c3"]) {
      expect(
        validateContentPackManifest(validManifest({ id })).some(
          (error) => error.field === "id",
        ),
      ).toBe(false);
    }
  });

  it("rejects uppercase ids", () => {
    const errors = validateContentPackManifest(
      validManifest({ id: "Cyberpunk-Neon" }),
    );
    expect(errors).toContainEqual({
      field: "id",
      message:
        "Pack id must be kebab-case (lowercase letters, numbers, hyphens)",
    });
  });

  it("rejects ids with a leading hyphen", () => {
    const errors = validateContentPackManifest(validManifest({ id: "-abc" }));
    expect(errors).toContainEqual({
      field: "id",
      message:
        "Pack id must be kebab-case (lowercase letters, numbers, hyphens)",
    });
  });

  it("rejects ids with a trailing hyphen", () => {
    const errors = validateContentPackManifest(validManifest({ id: "abc-" }));
    expect(errors).toContainEqual({
      field: "id",
      message:
        "Pack id must be kebab-case (lowercase letters, numbers, hyphens)",
    });
  });

  it("rejects single-character ids because the pattern needs a first and last character", () => {
    const errors = validateContentPackManifest(validManifest({ id: "a" }));
    expect(errors).toContainEqual({
      field: "id",
      message:
        "Pack id must be kebab-case (lowercase letters, numbers, hyphens)",
    });
  });

  it("rejects ids containing spaces after trim", () => {
    const errors = validateContentPackManifest(validManifest({ id: "a b" }));
    expect(errors).toContainEqual({
      field: "id",
      message:
        "Pack id must be kebab-case (lowercase letters, numbers, hyphens)",
    });
  });

  it("trims the id before checking emptiness but validates the raw value against the pattern", () => {
    const errors = validateContentPackManifest(validManifest({ id: " ab " }));
    expect(errors.some((error) => error.field === "id")).toBe(true);
    expect(errors.find((error) => error.field === "id")?.message).not.toBe(
      "Pack id is required",
    );
  });
});

describe("validateContentPackManifest assets checks", () => {
  it("requires an assets object", () => {
    const errors = validateContentPackManifest({
      id: "cyberpunk-neon",
      name: "Cyberpunk Neon",
      version: "1.0.0",
    });
    expect(errors).toEqual([
      { field: "assets", message: "Assets object is required" },
    ]);
  });

  it("requires assets to be an object when present as a primitive", () => {
    const errors = validateContentPackManifest(validManifest({ assets: 42 }));
    expect(errors).toContainEqual({
      field: "assets",
      message: "Assets object is required",
    });
  });

  it("returns accumulated field errors before the assets error", () => {
    const errors = validateContentPackManifest({
      id: "",
      name: "",
      version: "",
    });
    expect(errors.map((error) => error.field)).toEqual([
      "id",
      "name",
      "version",
      "assets",
    ]);
  });

  it("does not report asset-content errors once assets itself failed", () => {
    const errors = validateContentPackManifest(validManifest({ assets: "no" }));
    expect(errors.filter((error) => error.field.startsWith("assets."))).toEqual(
      [],
    );
  });
});

describe("validateContentPackManifest vrm checks", () => {
  it("reports no vrm errors when vrm is omitted", () => {
    expect(validateContentPackManifest(validManifest())).toEqual([]);
  });

  it("reports no vrm errors when vrm is null", () => {
    expect(
      validateContentPackManifest(validManifest({ assets: { vrm: null } })),
    ).toEqual([]);
  });

  it("rejects a non-object vrm", () => {
    const errors = validateContentPackManifest(
      validManifest({ assets: { vrm: "model.vrm" } }),
    );
    expect(errors).toEqual([
      { field: "assets.vrm", message: "VRM must be an object" },
    ]);
  });

  it("rejects an array vrm", () => {
    const errors = validateContentPackManifest(
      validManifest({ assets: { vrm: [] } }),
    );
    expect(errors).toEqual([
      { field: "assets.vrm", message: "VRM must be an object" },
    ]);
  });

  it("requires both vrm file and slug on an otherwise empty vrm object", () => {
    const errors = validateContentPackManifest(
      validManifest({ assets: { vrm: {} } }),
    );
    expect(errors).toEqual([
      { field: "assets.vrm.file", message: "VRM file path is required" },
      { field: "assets.vrm.slug", message: "VRM slug is required" },
    ]);
  });

  it("treats whitespace-only vrm file and slug values as missing", () => {
    const errors = validateContentPackManifest(
      validManifest({ assets: { vrm: { file: "  ", slug: " " } } }),
    );
    expect(errors).toEqual([
      { field: "assets.vrm.file", message: "VRM file path is required" },
      { field: "assets.vrm.slug", message: "VRM slug is required" },
    ]);
  });

  it("accepts a vrm with file, slug, and optional preview", () => {
    expect(
      validateContentPackManifest(
        validManifest({
          assets: {
            vrm: {
              file: "avatar.vrm.gz",
              slug: "avatar",
              preview: "thumbs/avatar.png",
            },
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe("validateContentPackManifest colorScheme checks", () => {
  it("rejects a non-object colorScheme", () => {
    const errors = validateContentPackManifest(
      validManifest({ assets: { colorScheme: "#ff00ff" } }),
    );
    expect(errors).toEqual([
      {
        field: "assets.colorScheme",
        message: "Color scheme must be an object",
      },
    ]);
  });

  it("rejects an array colorScheme", () => {
    const errors = validateContentPackManifest(
      validManifest({ assets: { colorScheme: [] } }),
    );
    expect(errors).toEqual([
      {
        field: "assets.colorScheme",
        message: "Color scheme must be an object",
      },
    ]);
  });

  it("flags every non-hex color field with its own field path and message", () => {
    const errors = validateContentPackManifest(
      validManifest({
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
    expect(errors).toEqual([
      {
        field: "assets.colorScheme.accent",
        message: "Color value must be a valid hex color (e.g. #ff00ff)",
      },
      {
        field: "assets.colorScheme.bg",
        message: "Color value must be a valid hex color (e.g. #ff00ff)",
      },
      {
        field: "assets.colorScheme.card",
        message: "Color value must be a valid hex color (e.g. #ff00ff)",
      },
      {
        field: "assets.colorScheme.border",
        message: "Color value must be a valid hex color (e.g. #ff00ff)",
      },
      {
        field: "assets.colorScheme.text",
        message: "Color value must be a valid hex color (e.g. #ff00ff)",
      },
      {
        field: "assets.colorScheme.textMuted",
        message: "Color value must be a valid hex color (e.g. #ff00ff)",
      },
    ]);
  });

  it("accepts 3, 4, 6, and 8 digit hex colors in lower and upper case", () => {
    expect(
      validateContentPackManifest(
        validManifest({
          assets: {
            colorScheme: {
              accent: "#fff",
              bg: "#ffff",
              card: "#ff00ff",
              border: "#FFFFFF",
              text: "#aabbccdd",
              textMuted: "#ABCDEF12",
            },
          },
        }),
      ),
    ).toEqual([]);
  });

  it("rejects hex-like strings that are too short or lack the hash prefix", () => {
    const errors = validateContentPackManifest(
      validManifest({
        assets: {
          colorScheme: { accent: "#ff", bg: "ff00ff", text: "#123456789" },
        },
      }),
    );
    expect(errors.map((error) => error.field)).toEqual([
      "assets.colorScheme.accent",
      "assets.colorScheme.bg",
      "assets.colorScheme.text",
    ]);
  });

  it("ignores non-string color values instead of validating them", () => {
    expect(
      validateContentPackManifest(
        validManifest({
          assets: { colorScheme: { accent: 16711935, bg: null, card: true } },
        }),
      ),
    ).toEqual([]);
  });

  it("ignores customProperties entirely", () => {
    expect(
      validateContentPackManifest(
        validManifest({
          assets: {
            colorScheme: {
              accent: "#ff00ff",
              customProperties: { glow: "bright" },
            },
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe("validateContentPackManifest combined failures", () => {
  it("accumulates independent field errors in declaration order", () => {
    const errors = validateContentPackManifest(
      validManifest({
        id: "Bad_Id",
        name: "",
        version: "",
        assets: { vrm: {}, colorScheme: { accent: "red" } },
      }),
    );
    expect(errors.map((error) => error.field)).toEqual([
      "id",
      "name",
      "version",
      "assets.vrm.file",
      "assets.vrm.slug",
      "assets.colorScheme.accent",
    ]);
  });

  it("still returns an empty array for a fully populated valid manifest", () => {
    expect(
      validateContentPackManifest(
        validManifest({
          author: "elizaOS",
          description: "Neon city pack",
          preview: "preview.png",
          assets: {
            vrm: { file: "a.vrm", slug: "a" },
            background: "bg.png",
            world: "world.json",
            colorScheme: { accent: "#ff00ff" },
            streamOverlay: "overlay/",
            personality: { catchphrase: "hello" },
          },
        }),
      ),
    ).toEqual([]);
  });
});
