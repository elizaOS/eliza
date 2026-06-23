import { stripAssistantStageDirections } from "@elizaos/shared";
import type { ConversationMessage } from "../../api/client-types-chat";
import type { PluginInfo } from "../../api/client-types-config";
import type { JsonSchemaObject } from "../../config/config-catalog";
import type { PatchOp, UiSpec } from "../../config/ui-spec";
import type { ConfigUiHint } from "../../types";
import {
  type PermissionCardPayload,
  parsePermissionRequestFromText,
} from "../composites/chat/permission-card.helpers";
import { paramsToSchema } from "../pages/plugin-list-utils";
import { getInlineWidgets } from "./widgets/inline-registry";

/** Reject prototype-pollution keys that should never be traversed or rendered. */
export const BLOCKED_IDS = new Set(["__proto__", "constructor", "prototype"]);
export const SAFE_PLUGIN_ID_RE = /^[\w-]+$/;

export function createSafeRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

export function sanitizePatchValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePatchValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const safe = createSafeRecord();
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (BLOCKED_IDS.has(key)) continue;
    safe[key] = sanitizePatchValue(nestedValue);
  }
  return safe;
}

export function isSafeNormalizedPluginId(id: string): boolean {
  return !BLOCKED_IDS.has(id) && SAFE_PLUGIN_ID_RE.test(id);
}

// ── Segment types ───────────────────────────────────────────────────

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "config"; pluginId: string }
  | { kind: "ui-spec"; spec: UiSpec; raw: string }
  // Any registry-driven inline widget (choice/followups/form/task/plugin).
  | { kind: "widget"; widgetKind: string; data: unknown }
  | { kind: "permission"; payload: PermissionCardPayload }
  | { kind: "analysis-xml"; tag: string; content: string };

// ── Detection ───────────────────────────────────────────────────────

export const CONFIG_RE = /\[CONFIG:([@\w][\w@./:-]*)\]/g;
export const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)```/g;

export const HIDDEN_TAG_BLOCK_RE =
  /<(think|analysis|reasoning|tool_calls?|tools?)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;

/**
 * Strip trailing partial hidden tags at the end of a streaming text chunk.
 * During streaming, the buffer may end mid-tag (e.g. `"Hello<thi"`,
 * `"Hello</respon"`, or just `"Hello<"`).  These fragments are not
 * user-facing content and must be hidden from both the display and voice
 * pipelines.
 */
export const TRAILING_PARTIAL_TAG_RE = /<\/?[a-zA-Z][^>]*$|<\/?$/s;

export function normalizeDisplayText(text: string): string {
  // Bound input length to keep the regex passes linear in adversarial cases.
  const MAX_DISPLAY_LEN = 200_000;
  let normalized =
    text.length > MAX_DISPLAY_LEN ? text.slice(0, MAX_DISPLAY_LEN) : text;

  // Hide hidden reasoning/tool blocks from chat bubbles.
  normalized = normalized.replace(HIDDEN_TAG_BLOCK_RE, " ");

  // During streaming, a chunk may end mid-tag (e.g. "<thi").
  // Strip any unterminated opening or closing tag at the very end so the
  // user never sees hidden-tag fragments while tokens arrive.
  normalized = normalized.replace(TRAILING_PARTIAL_TAG_RE, "");

  normalized = stripAssistantStageDirections(normalized);
  return normalized.trim();
}

export function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function isUiSpec(obj: unknown): obj is UiSpec {
  if (!obj || typeof obj !== "object") return false;
  const c = obj as Record<string, unknown>;
  return (
    typeof c.root === "string" &&
    typeof c.elements === "object" &&
    c.elements !== null
  );
}

// ── JSONL patch support (Chat Mode) ─────────────────────────────────

/**
 * Quick pre-check: does this line look like a JSON patch object?
 * Handles both compact `{"op":` and spaced `{ "op":` formats.
 */
export function looksLikePatch(trimmed: string): boolean {
  if (!trimmed.startsWith("{")) return false;
  return trimmed.includes('"op"') && trimmed.includes('"path"');
}

/** Try to parse a single line as an RFC 6902 JSON Patch operation. */
export function tryParsePatch(line: string): PatchOp | null {
  const t = line.trim();
  if (!looksLikePatch(t)) return null;
  try {
    const obj = JSON.parse(t) as Record<string, unknown>;
    if (typeof obj.op === "string" && typeof obj.path === "string")
      return obj as PatchOp;
    return null;
  } catch {
    return null;
  }
}

/**
 * Apply a list of RFC 6902 patches to build a UiSpec.
 *
 * Only handles the paths the catalog emits:
 *   /root              → spec.root
 *   /elements/<id>     → spec.elements[id]
 *   /state/<key>       → spec.state[key]
 *   /state             → spec.state (whole object)
 */
export function compilePatches(patches: PatchOp[]): UiSpec | null {
  const spec: {
    root?: string;
    elements: Record<string, unknown>;
    state: Record<string, unknown>;
  } = { elements: {}, state: createSafeRecord() };

  for (const patch of patches) {
    if (patch.op !== "add" && patch.op !== "replace") continue;
    const { path, value } = patch as {
      op: string;
      path: string;
      value: unknown;
    };
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    if (parts[0] === "root" && parts.length === 1) {
      spec.root = value as string;
    } else if (parts[0] === "elements" && parts.length === 2) {
      spec.elements[parts[1]] = value;
    } else if (parts[0] === "state" && parts.length === 1) {
      const nextState = sanitizePatchValue(value);
      spec.state =
        nextState && typeof nextState === "object" && !Array.isArray(nextState)
          ? (nextState as Record<string, unknown>)
          : createSafeRecord();
    } else if (parts[0] === "state" && parts.length >= 2) {
      // Nested state path: /state/key or /state/key/subkey
      let cursor = spec.state;
      let blockedPath = false;
      for (let i = 1; i < parts.length - 1; i++) {
        const k = parts[i];
        if (BLOCKED_IDS.has(k)) {
          blockedPath = true;
          break;
        }
        if (
          !cursor[k] ||
          typeof cursor[k] !== "object" ||
          Array.isArray(cursor[k])
        ) {
          cursor[k] = createSafeRecord();
        }
        cursor = cursor[k] as Record<string, unknown>;
      }
      if (blockedPath) continue;
      const leaf = parts[parts.length - 1];
      if (BLOCKED_IDS.has(leaf)) continue;
      cursor[leaf] = sanitizePatchValue(value);
    }
  }

  return isUiSpec(spec) ? spec : null;
}

/**
 * Scan `text` for blocks of consecutive JSONL patch lines and return
 * their character regions plus the compiled UiSpec.
 *
 * A patch block is a run of lines where each non-empty line parses as a
 * valid PatchOp. A single empty line between patch lines is allowed.
 */
export function findPatchRegions(
  text: string,
): Array<{ start: number; end: number; spec: UiSpec; raw: string }> {
  const results: Array<{
    start: number;
    end: number;
    spec: UiSpec;
    raw: string;
  }> = [];
  const lines = text.split("\n");

  let blockStart = -1;
  let blockEnd = 0;
  let patches: PatchOp[] = [];
  let rawLines: string[] = [];
  let pos = 0;

  const flush = () => {
    if (patches.length >= 1) {
      const spec = compilePatches(patches);
      if (spec) {
        results.push({
          start: blockStart,
          end: blockEnd,
          spec,
          raw: rawLines.join("\n"),
        });
      }
    }
    blockStart = -1;
    patches = [];
    rawLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // +1 for the newline that split() consumed (except the very last line)
    const lineLen = line.length + (i < lines.length - 1 ? 1 : 0);
    const trimmed = line.trim();

    if (looksLikePatch(trimmed)) {
      const patch = tryParsePatch(trimmed);
      if (patch) {
        if (blockStart === -1) blockStart = pos;
        patches.push(patch);
        rawLines.push(line);
        blockEnd = pos + lineLen;
        pos += lineLen;
        continue;
      }
    }

    // Empty line: peek ahead to see if the next non-empty line is a patch
    if (trimmed.length === 0 && blockStart !== -1) {
      const nextPatch = lines.slice(i + 1).find((l) => l.trim().length > 0);
      if (nextPatch && tryParsePatch(nextPatch) !== null) {
        // Allow the gap and keep going
        pos += lineLen;
        continue;
      }
    }

    // Non-patch content — flush any open block
    if (blockStart !== -1) flush();
    pos += lineLen;
  }

  if (blockStart !== -1) flush();
  return results;
}

export function parseSegments(text: string, analysisMode: boolean): Segment[] {
  // If analysis mode is enabled, we parse the raw text to extract XML blocks,
  // otherwise we use the normalized text which strips them.
  const targetText = analysisMode ? text : normalizeDisplayText(text);
  if (!targetText) return [{ kind: "text", text: "" }];

  const permissionRequest = analysisMode
    ? null
    : parsePermissionRequestFromText(targetText);
  if (permissionRequest) {
    const segments: Segment[] = [];
    if (permissionRequest.display.trim()) {
      segments.push({ kind: "text", text: permissionRequest.display });
    }
    segments.push({ kind: "permission", payload: permissionRequest.payload });
    return segments;
  }

  // Build a list of match regions sorted by position
  const regions: Array<{ start: number; end: number; segment: Segment }> = [];

  if (analysisMode) {
    const XML_RE =
      /<(thought|analysis|reasoning|tool_calls?|tools?|action|providers?|response|text)\b[^>]*>([\s\S]*?)(?:<\/\1>|$)/gi;
    let m: RegExpExecArray | null = XML_RE.exec(targetText);
    while (m !== null) {
      regions.push({
        start: m.index,
        end: m.index + m[0].length,
        segment: {
          kind: "analysis-xml",
          tag: m[1].toLowerCase(),
          content: m[2],
        },
      });
      m = XML_RE.exec(targetText);
    }
  }

  // 1. Find [CONFIG:pluginId] markers
  CONFIG_RE.lastIndex = 0;
  let m: RegExpExecArray | null = CONFIG_RE.exec(targetText);
  while (m !== null) {
    regions.push({
      start: m.index,
      end: m.index + m[0].length,
      segment: { kind: "config", pluginId: m[1] },
    });
    m = CONFIG_RE.exec(targetText);
  }

  // 1b. Registry-driven inline widgets (choice/followups/form/task and any
  // plugin-registered marker). Each widget owns its parsing semantics; we only
  // collect the regions and tag them with the widget kind for render dispatch.
  for (const widget of getInlineWidgets()) {
    for (const match of widget.parse(targetText)) {
      regions.push({
        start: match.start,
        end: match.end,
        segment: {
          kind: "widget",
          widgetKind: widget.kind,
          data: match.data,
        },
      });
    }
  }

  // 2. Find fenced JSON that is a UiSpec (Generate Mode / legacy format)
  FENCED_JSON_RE.lastIndex = 0;
  m = FENCED_JSON_RE.exec(targetText);
  while (m !== null) {
    const json = m[1].trim();
    const parsed = tryParse(json);
    if (parsed && isUiSpec(parsed)) {
      regions.push({
        start: m.index,
        end: m.index + m[0].length,
        segment: { kind: "ui-spec", spec: parsed, raw: json },
      });
    }
    m = FENCED_JSON_RE.exec(targetText);
  }

  // 3. Find inline JSONL patch blocks (Chat Mode)
  for (const patch of findPatchRegions(targetText)) {
    // Skip if this region overlaps with an already-found fenced block
    const overlaps = regions.some(
      (r) => patch.start < r.end && patch.end > r.start,
    );
    if (!overlaps) {
      regions.push({
        start: patch.start,
        end: patch.end,
        segment: { kind: "ui-spec", spec: patch.spec, raw: patch.raw },
      });
    }
  }

  // No special content found — return plain text
  if (regions.length === 0) {
    return [{ kind: "text", text: targetText }];
  }

  // Sort by start position, then interleave with text segments
  regions.sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let cursor = 0;

  for (const r of regions) {
    // Skip overlapping regions
    if (r.start < cursor) continue;

    // Push preceding text
    if (r.start > cursor) {
      const t = targetText.slice(cursor, r.start);
      if (t.trim()) segments.push({ kind: "text", text: t });
    }
    segments.push(r.segment);
    cursor = r.end;
  }

  // Trailing text
  if (cursor < targetText.length) {
    const t = targetText.slice(cursor);
    if (t.trim()) segments.push({ kind: "text", text: t });
  }

  return segments;
}

// ── InlinePluginConfig helpers ──────────────────────────────────────

/** Normalize plugin ID: strip @scope/plugin- prefix so both "discord" and "@elizaos/plugin-discord" resolve. */
export function normalizePluginId(id: string): string {
  return id.replace(/^@[^/]+\/plugin-/, "");
}

export function buildInlinePluginConfigModel(
  plugin: PluginInfo | null,
  values: Record<string, unknown>,
): {
  hasConfigurableParams: boolean;
  hints: Record<string, ConfigUiHint>;
  mergedValues: Record<string, unknown>;
  schema: JsonSchemaObject | null;
  setKeys: Set<string>;
} {
  const pluginParams = plugin?.parameters ?? [];
  const hasConfigurableParams = pluginParams.length > 0;
  if (!hasConfigurableParams || !plugin?.id) {
    return {
      hasConfigurableParams: false,
      hints: {},
      mergedValues: values,
      schema: null,
      setKeys: new Set<string>(),
    };
  }

  const auto = paramsToSchema(pluginParams, plugin.id);
  if (plugin.configUiHints) {
    for (const [key, serverHint] of Object.entries(plugin.configUiHints)) {
      auto.hints[key] = { ...auto.hints[key], ...serverHint };
    }
  }

  const initialValues: Record<string, unknown> = {};
  const setKeys = new Set<string>();
  for (const param of pluginParams) {
    if (param.isSet) {
      setKeys.add(param.key);
    }
    if (param.isSet && !param.sensitive && param.currentValue != null) {
      initialValues[param.key] = param.currentValue;
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (value != null && value !== "") {
      setKeys.add(key);
    }
  }

  return {
    hasConfigurableParams: true,
    hints: auto.hints,
    mergedValues: { ...initialValues, ...values },
    schema: auto.schema as JsonSchemaObject,
    setKeys,
  };
}

// ── SensitiveRequestBlock helpers ───────────────────────────────────

export function sensitiveRequestStatusLabel(
  status: NonNullable<ConversationMessage["secretRequest"]>["status"],
): string {
  switch (status) {
    case "saved":
    case "submitted":
    case "fulfilled":
      return "Saved";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    default:
      return "Pending";
  }
}
