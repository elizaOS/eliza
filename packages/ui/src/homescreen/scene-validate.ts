/**
 * Validation for {@link HomescreenScene} documents.
 *
 * The HOMESCREEN agent action forwards the model's structured output verbatim;
 * the client is the single place that validates it before applying. This keeps
 * the action thin (rule 4) and the client authoritative over what it renders
 * (rule 3). A rejected document never reaches the runtime — the editor keeps the
 * prior scene and surfaces the error.
 */

import {
  BLOCK_IDS,
  type BlockConfig,
  type BlockLayout,
  type BlocksConfig,
  type BlockTheme,
  createDefaultScene,
  defaultBlocks,
  type HomescreenScene,
  type SceneBackground,
  type SceneTheme,
} from "./scene-types";

export interface SceneValidationOk {
  ok: true;
  scene: HomescreenScene;
}
export interface SceneValidationErr {
  ok: false;
  errors: string[];
}
export type SceneValidationResult = SceneValidationOk | SceneValidationErr;

const ANCHORS: ReadonlySet<BlockLayout["anchor"]> = new Set([
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function coerceTheme(raw: unknown, errors: string[]): SceneTheme {
  const fallback = createDefaultScene().theme;
  if (!isObject(raw)) return { ...fallback };
  let accent = fallback.accent;
  if (Array.isArray(raw.accent) && raw.accent.length === 3) {
    const a = raw.accent.map((c) => clamp01(num(c, 0)));
    accent = [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0];
  } else if (raw.accent !== undefined) {
    errors.push("theme.accent must be [r,g,b] in 0..1");
  }
  let background = fallback.background;
  if (typeof raw.background === "number" && Number.isInteger(raw.background)) {
    background = raw.background & 0xffffff;
  } else if (raw.background !== undefined) {
    errors.push("theme.background must be an integer hex color");
  }
  return { accent, background };
}

function coerceLayout(raw: unknown): BlockLayout {
  const base: BlockLayout = {
    anchor: "top-center",
    offset: { x: 0, y: 0 },
    collapsed: false,
    hidden: false,
  };
  if (!isObject(raw)) return base;
  const anchor =
    typeof raw.anchor === "string" &&
    ANCHORS.has(raw.anchor as BlockLayout["anchor"])
      ? (raw.anchor as BlockLayout["anchor"])
      : base.anchor;
  const offset = isObject(raw.offset)
    ? { x: num(raw.offset.x, 0), y: num(raw.offset.y, 0) }
    : base.offset;
  return {
    anchor,
    offset,
    collapsed: raw.collapsed === true,
    hidden: raw.hidden === true,
  };
}

function coerceBlockTheme(raw: unknown): BlockTheme {
  if (!isObject(raw))
    return { surface: null, text: null, radius: null, blur: null };
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const n = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    surface: str(raw.surface),
    text: str(raw.text),
    radius: n(raw.radius),
    blur: n(raw.blur),
  };
}

function coerceBlocks(raw: unknown): BlocksConfig {
  const base = defaultBlocks();
  if (!isObject(raw)) return base;
  const out = base;
  for (const id of BLOCK_IDS) {
    const entry = raw[id];
    if (!isObject(entry)) continue;
    const block: BlockConfig = {
      layout: coerceLayout(entry.layout),
      theme: coerceBlockTheme(entry.theme),
    };
    out[id] = block;
  }
  return out;
}

function coerceBackground(raw: unknown, errors: string[]): SceneBackground {
  if (!isObject(raw)) {
    errors.push("background is required");
    return createDefaultScene().background;
  }
  if (raw.kind === "preset") {
    if (typeof raw.preset !== "string" || raw.preset.length === 0) {
      errors.push("background.preset must be a non-empty string");
      return createDefaultScene().background;
    }
    return { kind: "preset", preset: raw.preset };
  }
  if (raw.kind === "script") {
    if (typeof raw.code !== "string" || raw.code.trim().length === 0) {
      errors.push("background.code must be a non-empty string");
      return createDefaultScene().background;
    }
    return { kind: "script", code: raw.code };
  }
  errors.push('background.kind must be "preset" or "script"');
  return createDefaultScene().background;
}

/**
 * Validate and normalize an unknown value into a {@link HomescreenScene}.
 *
 * Lenient by design: missing optional fields (theme, blocks, name) are filled
 * from defaults so a model that emits only a `background` still produces a
 * usable scene. Hard errors (no/invalid background, malformed accent) fail the
 * whole document so the editor can keep the previous scene.
 */
export function validateScene(input: unknown): SceneValidationResult {
  const errors: string[] = [];
  if (!isObject(input)) {
    return { ok: false, errors: ["scene must be an object"] };
  }
  const background = coerceBackground(input.background, errors);
  const theme = coerceTheme(input.theme, errors);
  const blocks = coerceBlocks(input.blocks);

  // Hard failures abort; soft normalizations are kept.
  const hardError = errors.find(
    (e) => e.startsWith("background") || e.startsWith("scene"),
  );
  if (hardError) return { ok: false, errors };

  const scene: HomescreenScene = {
    id:
      typeof input.id === "string" && input.id.length > 0
        ? input.id
        : `scene-${Date.now().toString(36)}`,
    name:
      typeof input.name === "string" && input.name.trim().length > 0
        ? input.name.trim().slice(0, 60)
        : "Custom",
    version: 1,
    background,
    theme,
    blocks,
    updatedAt:
      typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)
        ? input.updatedAt
        : Date.now(),
  };
  return { ok: true, scene };
}
