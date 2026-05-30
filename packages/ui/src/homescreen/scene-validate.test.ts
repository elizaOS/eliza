import { describe, expect, it } from "vitest";
import {
  BLOCK_IDS,
  BUILTIN_PRESETS,
  createDefaultScene,
  defaultBlocks,
} from "./scene-types";
import { validateScene } from "./scene-validate";

describe("validateScene", () => {
  it("accepts a minimal preset document and fills defaults", () => {
    const result = validateScene({
      background: { kind: "preset", preset: "fresnel-crystal-ball" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.background).toEqual({
      kind: "preset",
      preset: "fresnel-crystal-ball",
    });
    // Missing theme/blocks/name come from defaults.
    expect(result.scene.theme).toEqual(createDefaultScene().theme);
    expect(result.scene.blocks).toEqual(defaultBlocks());
    expect(result.scene.name).toBe("Custom");
    expect(result.scene.version).toBe(1);
  });

  it("accepts a script document", () => {
    const result = validateScene({
      background: { kind: "script", code: "return { update(){}, dispose(){} };" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.background.kind).toBe("script");
  });

  it("rejects a non-object input", () => {
    const result = validateScene(42);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/scene must be an object/);
  });

  it("hard-fails when background is missing", () => {
    const result = validateScene({ theme: { background: 0x000000 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.startsWith("background"))).toBe(true);
  });

  it("hard-fails on an unknown background kind", () => {
    const result = validateScene({ background: { kind: "video", src: "x" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.startsWith("background.kind"))).toBe(true);
  });

  it("hard-fails on an empty script body", () => {
    const result = validateScene({ background: { kind: "script", code: "   " } });
    expect(result.ok).toBe(false);
  });

  it("clamps accent components into 0..1", () => {
    const result = validateScene({
      background: { kind: "preset", preset: "p" },
      theme: { accent: [2, -1, 0.5] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.theme.accent).toEqual([1, 0, 0.5]);
  });

  it("records a soft error but still succeeds on a malformed accent", () => {
    // accent wrong shape -> soft error, theme falls back, scene still valid
    const result = validateScene({
      background: { kind: "preset", preset: "p" },
      theme: { accent: "orange" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.theme.accent).toEqual(createDefaultScene().theme.accent);
  });

  it("normalizes block layout anchors and rejects unknown anchors", () => {
    const result = validateScene({
      background: { kind: "preset", preset: "p" },
      blocks: {
        chat: { layout: { anchor: "nowhere" } },
        apps: { layout: { anchor: "bottom-left", offset: { x: 10, y: -4 } } },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Unknown anchor falls back to the default top-center.
    expect(result.scene.blocks.chat.layout.anchor).toBe("top-center");
    expect(result.scene.blocks.apps.layout.anchor).toBe("bottom-left");
    expect(result.scene.blocks.apps.layout.offset).toEqual({ x: 10, y: -4 });
  });

  it("truncates an overlong name to 60 chars", () => {
    const long = "x".repeat(200);
    const result = validateScene({
      background: { kind: "preset", preset: "p" },
      name: long,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.name.length).toBe(60);
  });
});

describe("scene defaults", () => {
  it("createDefaultScene is internally consistent", () => {
    const scene = createDefaultScene();
    expect(scene.background).toEqual({
      kind: "preset",
      preset: BUILTIN_PRESETS.fresnelCrystalBall,
    });
    for (const id of BLOCK_IDS) {
      expect(scene.blocks[id]).toBeDefined();
    }
  });

  it("a default scene round-trips through validateScene unchanged", () => {
    const scene = createDefaultScene();
    const result = validateScene(scene);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.background).toEqual(scene.background);
    expect(result.scene.theme).toEqual(scene.theme);
    expect(result.scene.blocks).toEqual(scene.blocks);
  });
});
