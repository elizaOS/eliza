/**
 * Bounded Scene prompt serializer with structural secure-field redaction.
 *
 * The complete Scene stays available in provider data and ComputerUseService.
 * The model prompt receives a deterministic, focus-first projection so a large
 * accessibility tree cannot overflow the routing model before it can choose a
 * computer-use action. Omission is explicit and never affects action-time scene
 * access. Password and secure-text overlaps remain structurally redacted.
 *
 * The output is fenced JSON for predictable downstream tokenization.
 */

import type { Scene } from "./scene-types.js";

const REDACTED_SECURE_FIELD = "[REDACTED_SECURE_FIELD]";
const DEFAULT_OCR_MAX = 64;
const DEFAULT_AX_MAX = 128;
const DEFAULT_APP_MAX = 32;
const DEFAULT_WINDOWS_PER_APP_MAX = 4;
const DEFAULT_VLM_MAX = 32;
const DEFAULT_TEXT_MAX_CHARS = 192;
const MAX_AX_ACTIONS = 8;
const MAX_AX_ACTION_CHARS = 48;

function isSecureAxRole(role: string): boolean {
  const normalized = role.toLowerCase().replaceAll(/[^a-z]/g, "");
  return (
    normalized.includes("password") || normalized.includes("securetextfield")
  );
}

function overlaps(
  left: [number, number, number, number],
  right: [number, number, number, number],
): boolean {
  return (
    left[0] < right[0] + right[2] &&
    left[0] + left[2] > right[0] &&
    left[1] < right[1] + right[3] &&
    left[1] + left[3] > right[1]
  );
}

export interface SerializeOptions {
  /** Maximum OCR boxes rendered into the model prompt. */
  ocrTopN?: number;
  /** Maximum accessibility nodes rendered into the model prompt. */
  axMax?: number;
  /** Maximum windows rendered per application. */
  appTopWindows?: number;
  /** Maximum applications rendered into the model prompt. */
  appMax?: number;
  /** Maximum VLM elements rendered into the model prompt. */
  vlmMax?: number;
  /** Maximum characters retained for any model-visible text field. */
  textMaxChars?: number;
}

function boundedCount(value: number | undefined, fallback: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.floor(value as number))
    : fallback;
}

function boundedText(value: string | undefined, maxChars: number): string {
  if (!value) return "";
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function serializeSceneForPrompt(
  scene: Scene,
  options: SerializeOptions = {},
): string {
  const ocrMax = boundedCount(options.ocrTopN, DEFAULT_OCR_MAX);
  const axMax = boundedCount(options.axMax, DEFAULT_AX_MAX);
  const appMax = boundedCount(options.appMax, DEFAULT_APP_MAX);
  const windowsPerAppMax = boundedCount(
    options.appTopWindows,
    DEFAULT_WINDOWS_PER_APP_MAX,
  );
  const vlmMax = boundedCount(options.vlmMax, DEFAULT_VLM_MAX);
  const textMaxChars = Math.max(
    32,
    boundedCount(options.textMaxChars, DEFAULT_TEXT_MAX_CHARS),
  );

  const ocrByDisplay = new Map<number, typeof scene.ocr>();
  for (const box of scene.ocr) {
    const arr = ocrByDisplay.get(box.displayId) ?? [];
    arr.push(box);
    ocrByDisplay.set(box.displayId, arr);
  }
  const orderedOcr: typeof scene.ocr = [];
  for (const [, arr] of ocrByDisplay) {
    arr.sort((a, b) => b.conf - a.conf);
    orderedOcr.push(...arr);
  }
  const projectedOcr = orderedOcr.slice(0, ocrMax);

  const focusedDisplay =
    scene.focused_window?.displayId ?? scene.displays[0]?.id ?? 0;
  const focusedAx = scene.ax.filter((n) => n.displayId === focusedDisplay);
  const remainingAx = scene.ax.filter((n) => n.displayId !== focusedDisplay);
  const orderedAx = [...focusedAx, ...remainingAx];
  const projectedAx = orderedAx.slice(0, axMax);
  // Redact projected OCR against the complete secure-field set. A prompt cap
  // must never turn omission into a credential leak.
  const secureFields = orderedAx.filter((node) => isSecureAxRole(node.role));

  const appsByPriority = [...scene.apps].sort((a, b) => {
    const aw = a.windows.length;
    const bw = b.windows.length;
    if (aw !== bw) return bw - aw;
    return a.name.localeCompare(b.name);
  });
  const compactApps = appsByPriority.slice(0, appMax).map((app) => ({
    name: boundedText(app.name, textMaxChars),
    pid: app.pid,
    window_count: app.windows.length,
    windows: app.windows.slice(0, windowsPerAppMax).map((window) => ({
      id: boundedText(window.id, textMaxChars),
      title: boundedText(window.title, textMaxChars),
      displayId: window.displayId,
    })),
  }));

  const projectedVlmElements = scene.vlm_elements?.slice(0, vlmMax) ?? null;
  const sourceWindowCount = scene.apps.reduce(
    (total, app) => total + app.windows.length,
    0,
  );
  const retainedWindowCount = compactApps.reduce(
    (total, app) => total + app.windows.length,
    0,
  );
  const omitted = {
    apps: Math.max(0, scene.apps.length - compactApps.length),
    windows: Math.max(0, sourceWindowCount - retainedWindowCount),
    ocr: Math.max(0, scene.ocr.length - projectedOcr.length),
    ax: Math.max(0, scene.ax.length - projectedAx.length),
    vlm_elements: Math.max(
      0,
      (scene.vlm_elements?.length ?? 0) - (projectedVlmElements?.length ?? 0),
    ),
  };
  const projected = Object.values(omitted).some((count) => count > 0);

  const compact = {
    timestamp: scene.timestamp,
    displays: scene.displays.map((display) => ({
      id: display.id,
      name: boundedText(display.name, textMaxChars),
      bounds: display.bounds,
      primary: display.primary,
      scaleFactor: display.scaleFactor,
    })),
    focused_window: scene.focused_window
      ? {
          ...scene.focused_window,
          app: boundedText(scene.focused_window.app, textMaxChars),
          title: boundedText(scene.focused_window.title, textMaxChars),
        }
      : null,
    apps: compactApps,
    ocr: projectedOcr.map((box) => ({
      id: boundedText(box.id, textMaxChars),
      text: secureFields.some(
        (field) =>
          field.displayId === box.displayId && overlaps(field.bbox, box.bbox),
      )
        ? REDACTED_SECURE_FIELD
        : boundedText(box.text, textMaxChars),
      bbox: box.bbox,
      conf: Number(box.conf.toFixed(3)),
      displayId: box.displayId,
    })),
    ax: projectedAx.map((node) => ({
      id: boundedText(node.id, textMaxChars),
      role: boundedText(node.role, textMaxChars),
      label: isSecureAxRole(node.role)
        ? REDACTED_SECURE_FIELD
        : boundedText(node.label, textMaxChars),
      bbox: node.bbox,
      actions: node.actions
        .slice(0, MAX_AX_ACTIONS)
        .map((action) =>
          boundedText(action, Math.min(textMaxChars, MAX_AX_ACTION_CHARS)),
        ),
      displayId: node.displayId,
    })),
    vlm_scene: boundedText(scene.vlm_scene ?? undefined, textMaxChars) || null,
    vlm_elements: projectedVlmElements?.map((element) => ({
      ...element,
      id: boundedText(element.id, textMaxChars),
      kind: boundedText(element.kind, textMaxChars),
      desc: boundedText(element.desc, textMaxChars),
    })),
    redactions: secureFields.slice(0, axMax).map((field) => ({
      kind: "secure_field",
      bounds: field.bbox,
      displayId: field.displayId,
      reason: "Accessibility role marks this region as credential input",
    })),
    ...(projected
      ? {
          projection: {
            bounded: true,
            full_scene_available_in_provider_data: true,
            source_counts: {
              apps: scene.apps.length,
              windows: sourceWindowCount,
              ocr: scene.ocr.length,
              ax: scene.ax.length,
              vlm_elements: scene.vlm_elements?.length ?? 0,
            },
            retained_counts: {
              apps: compactApps.length,
              windows: retainedWindowCount,
              ocr: projectedOcr.length,
              ax: projectedAx.length,
              vlm_elements: projectedVlmElements?.length ?? 0,
            },
            omitted_counts: omitted,
          },
        }
      : {}),
  };
  return ["```json", JSON.stringify(compact, null, 2), "```"].join("\n");
}
