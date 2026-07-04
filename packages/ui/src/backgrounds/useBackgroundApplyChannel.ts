/**
 * useBackgroundApplyChannel — the single bridge that lets the agent drive the
 * unified app background from chat.
 *
 * The agent's BACKGROUND action broadcasts a `background:apply` view event
 * (server → WS → `emitViewEvent`); this hook is the one subscriber, applying it
 * to the same `BackgroundConfig` store the Background view and `AppBackground`
 * share. There is no second background mechanism: chat, the view, and undo all
 * funnel through `setBackgroundConfig` / `undoBackgroundConfig`.
 *
 * Mounted once, alongside `AppBackground` at the shell root, so it is always
 * listening regardless of which view is active — "make the background blue"
 * works from anywhere, not only on the Background view.
 */

import {
  BACKGROUND_APPLY_EVENT,
  type BackgroundApplyPayload,
} from "@elizaos/shared/events";
import { useViewEvent } from "../hooks/useViewEvent";
import {
  catalogEntryToConfig,
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_BACKGROUND_CONFIG,
  makeGlslConfig,
  resolveCatalogEntry,
} from "../state/ui-preferences";
import { useBackgroundConfig } from "../state/useBackgroundConfig";
import { loadUserBackgroundCatalog } from "../state/user-background-catalog";
import { getShaderPreset } from "./shader-presets";
import {
  isPlausibleFragmentSource,
  mergeUniforms,
  type ShaderUniformValues,
} from "./shader-schema";

export type {
  BackgroundApplyOp,
  BackgroundApplyPayload,
} from "@elizaos/shared/events";
export { BACKGROUND_APPLY_EVENT };

/** Pull a Partial<ShaderUniformValues> out of an untrusted payload field. */
function readUniformPatch(
  value: unknown,
): Partial<Record<keyof ShaderUniformValues, unknown>> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const patch: Partial<Record<keyof ShaderUniformValues, unknown>> = {};
  for (const k of ["u_speed", "u_scale", "u_intensity", "u_seed"] as const) {
    if (k in r) patch[k] = r[k];
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export function useBackgroundApplyChannel(): void {
  const {
    backgroundConfig,
    setBackgroundConfig,
    undoBackgroundConfig,
    redoBackgroundConfig,
  } = useBackgroundConfig();

  useViewEvent(BACKGROUND_APPLY_EVENT, (event) => {
    const payload = event.payload as BackgroundApplyPayload;
    const op = typeof payload.op === "string" ? payload.op : "set";

    if (op === "undo") {
      undoBackgroundConfig();
      return;
    }
    if (op === "redo") {
      // Forward half of undo/redo (#10694) — re-apply the last undone config.
      redoBackgroundConfig();
      return;
    }
    if (op === "reset") {
      setBackgroundConfig(DEFAULT_BACKGROUND_CONFIG);
      return;
    }

    // op === "set": build a config from the payload. `setBackgroundConfig`
    // normalizes (bad hex → default, image-without-url → shader, bad shader →
    // color field), so a partial or malformed payload can never wedge the
    // background into a broken state.
    const imageUrl =
      typeof payload.imageUrl === "string" && payload.imageUrl.length > 0
        ? payload.imageUrl
        : undefined;
    const color = typeof payload.color === "string" ? payload.color : undefined;
    const uniformPatch = readUniformPatch(payload.uniforms);
    const presetId =
      typeof payload.presetId === "string" ? payload.presetId : undefined;

    // ── Named catalog entry (#13538) ─────────────────────────────────────
    // The agent (or the gallery) can name a curated catalog entry. We resolve
    // it HERE, in the renderer, to a concrete config. Like `presetId`, the
    // name is the ONLY thing that crosses the broker: an unknown name resolves
    // to nothing and is ignored (never wedges the background — the #13523
    // confinement invariant), and a glsl entry still goes through the vetted
    // preset corpus, so no raw GLSL/URL can ride in on `catalogId`.
    const catalogId =
      typeof payload.catalogId === "string" ? payload.catalogId : undefined;
    if (catalogId) {
      // Curated catalog first, then the user's saved/generated entries (both
      // resolve to an image/color/named-preset config only — never raw code).
      let entry = resolveCatalogEntry(catalogId);
      if (!entry) {
        const needle = catalogId.trim().toLowerCase();
        entry = loadUserBackgroundCatalog().find(
          (e) =>
            e.id.toLowerCase() === needle || e.label.toLowerCase() === needle,
        );
      }
      if (entry) {
        const config = catalogEntryToConfig(
          entry,
          (id) => getShaderPreset(id)?.source,
        );
        if (config) setBackgroundConfig(config);
      }
      // Unknown catalog name → ignore (confinement: never wedge the bg).
      return;
    }

    // Raw GLSL text in the payload is deliberately NOT accepted (#11088):
    // presets are the only source of shader code, so a crafted `source` field
    // (e.g. a bounded-for GPU bomb that would slip past the static gate) has
    // no path to the compiler. Payloads may only name a preset id.
    const wantsGlsl = payload.mode === "glsl" || Boolean(presetId);

    // ── Programmable GLSL shader (#10694) ────────────────────────────────
    if (wantsGlsl) {
      // A uniform-only tweak ("make it slower") when a shader is already live:
      // keep the same source, merge the patch.
      const current = backgroundConfig;
      if (
        !presetId &&
        uniformPatch &&
        current.mode === "glsl" &&
        current.shader
      ) {
        setBackgroundConfig(
          makeGlslConfig({
            source: current.shader.source,
            presetId: current.shader.presetId,
            color: color ?? current.color,
            uniforms: mergeUniforms(current.shader.uniforms, uniformPatch),
          }),
        );
        return;
      }

      const preset = presetId ? getShaderPreset(presetId) : undefined;
      const source = preset?.source;
      if (source && isPlausibleFragmentSource(source)) {
        setBackgroundConfig(
          makeGlslConfig({
            source,
            presetId: preset?.id,
            color: color ?? current.color ?? DEFAULT_BACKGROUND_COLOR,
            uniforms: { ...(preset?.defaults ?? {}), ...(uniformPatch ?? {}) },
          }),
        );
      }
      // Unknown preset / implausible source → ignore (never wedge the bg).
      return;
    }

    const wantsImage = payload.mode === "image" || (!payload.mode && imageUrl);
    if (wantsImage && imageUrl) {
      setBackgroundConfig({
        mode: "image",
        color: color ?? backgroundConfig.color ?? DEFAULT_BACKGROUND_COLOR,
        imageUrl,
      });
    } else if (color) {
      setBackgroundConfig({ mode: "shader", color });
    }
  });
}
