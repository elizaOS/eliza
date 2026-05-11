import { Button } from "@elizaos/ui";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api/client";
import type { ConversationMessage } from "../../api/client-types-chat";
import type { PluginInfo } from "../../api/client-types-config";
import type { JsonSchemaObject } from "../../config/config-catalog";
import type { PatchOp, UiSpec } from "../../config/ui-spec";
import { useApp } from "../../state/useApp";
import type { ConfigUiHint } from "../../types";
import { stripAssistantStageDirections } from "../../utils/assistant-text";
import {
  createClientPermissionsRegistry,
  PermissionCard,
  type PermissionCardPayload,
  parsePermissionRequestFromText,
} from "../composites/chat/permission-card";
import { ConfigRenderer, defaultRegistry } from "../config-ui/config-renderer";
import { UiRenderer } from "../config-ui/ui-renderer";
import { paramsToSchema } from "../pages/plugin-list-utils";
import { findChoiceRegions } from "./message-choice-parser";
import { type ChoiceOption, ChoiceWidget } from "./widgets/ChoiceWidget";

/** Reject prototype-pollution keys that should never be traversed or rendered. */
const BLOCKED_IDS = new Set(["__proto__", "constructor", "prototype"]);
const SAFE_PLUGIN_ID_RE = /^[\w-]+$/;

function createSafeRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function sanitizePatchValue(value: unknown): unknown {
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

function isSafeNormalizedPluginId(id: string): boolean {
  return !BLOCKED_IDS.has(id) && SAFE_PLUGIN_ID_RE.test(id);
}

interface MessageContentProps {
  message: ConversationMessage;
  analysisMode?: boolean;
}

// ── Segment types ───────────────────────────────────────────────────

type Segment =
  | { kind: "text"; text: string }
  | { kind: "config"; pluginId: string }
  | { kind: "ui-spec"; spec: UiSpec; raw: string }
  | {
      kind: "choice";
      id: string;
      scope: string;
      options: ChoiceOption[];
    }
  | { kind: "permission"; payload: PermissionCardPayload }
  | { kind: "analysis-xml"; tag: string; content: string };

// ── Detection ───────────────────────────────────────────────────────

const CONFIG_RE = /\[CONFIG:([@\w][\w@./:-]*)\]/g;
const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)```/g;

const HIDDEN_TAG_BLOCK_RE =
  /<(think|analysis|reasoning|tool_calls?|tools?)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;

/**
 * Strip partial/incomplete hidden tags at the end of a streaming text chunk.
 * During streaming, the buffer may end mid-tag (e.g. `"Hello<thi"`,
 * `"Hello</respon"`, or just `"Hello<"`).  These fragments are not
 * user-facing content and must be hidden from both the display and voice
 * pipelines.
 */
const TRAILING_PARTIAL_TAG_RE = /<\/?[a-zA-Z][^>]*$|<\/?$/s;

export function normalizeDisplayText(text: string): string {
  // Bound input length to keep the regex passes linear in adversarial cases.
  const MAX_DISPLAY_LEN = 200_000;
  let normalized =
    text.length > MAX_DISPLAY_LEN ? text.slice(0, MAX_DISPLAY_LEN) : text;

  // Hide hidden reasoning/tool blocks from chat bubbles.
  normalized = normalized.replace(HIDDEN_TAG_BLOCK_RE, " ");

  // During streaming, a chunk may end mid-tag (e.g. "<thi").
  // Strip any incomplete opening or closing tag at the very end so the
  // user never sees hidden-tag fragments while tokens arrive.
  normalized = normalized.replace(TRAILING_PARTIAL_TAG_RE, "");

  normalized = stripAssistantStageDirections(normalized);
  return normalized.trim();
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isUiSpec(obj: unknown): obj is UiSpec {
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

function parseSegments(text: string, analysisMode: boolean): Segment[] {
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

  // 1b. Find [CHOICE:scope id=...] ... [/CHOICE] blocks
  for (const choice of findChoiceRegions(targetText)) {
    regions.push({
      start: choice.start,
      end: choice.end,
      segment: {
        kind: "choice",
        id: choice.id,
        scope: choice.scope,
        options: choice.options,
      },
    });
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

// ── InlinePluginConfig ──────────────────────────────────────────────

/** Normalize plugin ID: strip @scope/plugin- prefix so both "discord" and "@elizaos/plugin-discord" resolve. */
export function normalizePluginId(id: string): string {
  return id.replace(/^@[^/]+\/plugin-/, "");
}

function buildInlinePluginConfigModel(
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

function InlinePluginConfig({ pluginId: rawPluginId }: { pluginId: string }) {
  const pluginId = normalizePluginId(rawPluginId);
  const [plugin, setPlugin] = useState<PluginInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const mountedRef = useRef(true);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { setActionNotice, loadPlugins, t } = useApp();

  // Track mount state — reset to true on each mount (needed for StrictMode
  // which unmounts/remounts and would leave the ref false otherwise).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  // Self-contained: fetch plugin data directly from API
  const fetchPlugin = useCallback(async () => {
    try {
      const { plugins } = await client.getPlugins();
      if (!mountedRef.current) return;
      const found = plugins.find((p) => p.id === pluginId);
      setPlugin(found ?? null);
    } catch {
      if (mountedRef.current) {
        setError(
          t("messagecontent.LoadPluginInfoFailed", {
            defaultValue: "Couldn't load plugin info.",
          }),
        );
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [pluginId, t]);

  useEffect(() => {
    void fetchPlugin();
  }, [fetchPlugin]);

  const { hasConfigurableParams, hints, mergedValues, schema, setKeys } =
    useMemo(
      () => buildInlinePluginConfigModel(plugin, values),
      [plugin, values],
    );

  const handleChange = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setError(null);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v != null && v !== "") patch[k] = String(v);
      }
      await client.updatePlugin(pluginId, { config: patch });
      if (mountedRef.current) setSaved(true);
      await fetchPlugin();
    } catch (e: unknown) {
      if (mountedRef.current) {
        setError(
          e instanceof Error
            ? e.message
            : t("messagecontent.SaveFailed", {
                defaultValue: "Couldn't save changes.",
              }),
        );
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [pluginId, values, fetchPlugin, t]);

  const handleToggle = useCallback(
    async (enable: boolean) => {
      setEnabling(true);
      setError(null);
      try {
        // Save pending config first, then toggle — same as the Plugins page
        if (enable) {
          const patch: Record<string, string> = {};
          for (const [k, v] of Object.entries(values)) {
            if (v != null && v !== "") patch[k] = String(v);
          }
          if (Object.keys(patch).length > 0) {
            await client.updatePlugin(pluginId, { config: patch });
          }
        }
        // Exact same call as the ON button in PluginsView
        await client.updatePlugin(pluginId, { enabled: enable });
        // Refresh shared plugin state so Plugins page shows updated status
        await loadPlugins();
        if (enable && mountedRef.current) {
          const tabLabel =
            plugin?.category === "feature"
              ? t("messagecontent.FeaturesTabLabel", {
                  defaultValue: "Plugins > Features",
                })
              : plugin?.category === "connector"
                ? t("messagecontent.ConnectorsTabLabel", {
                    defaultValue: "Plugins > Connectors",
                  })
                : t("messagecontent.SystemTabLabel", {
                    defaultValue: "Plugins > System",
                  });
          setActionNotice(
            t("messagecontent.PluginEnabledNotice", {
              defaultValue: "{{name}} is on. Find it in {{tabLabel}}.",
              name: plugin?.name ?? pluginId,
              tabLabel,
            }),
            "success",
            4000,
          );
          setDismissed(true);
        }
        // Wait for agent restart then refresh (with cleanup on unmount)
        refreshTimerRef.current = setTimeout(() => void fetchPlugin(), 3000);
      } catch (e: unknown) {
        if (mountedRef.current) {
          setError(
            e instanceof Error
              ? e.message
              : enable
                ? t("messagecontent.EnablePluginFailed", {
                    defaultValue: "Couldn't enable this plugin.",
                  })
                : t("messagecontent.DisablePluginFailed", {
                    defaultValue: "Couldn't disable this plugin.",
                  }),
          );
        }
      } finally {
        if (mountedRef.current) setEnabling(false);
      }
    },
    [pluginId, plugin, values, fetchPlugin, loadPlugins, setActionNotice, t],
  );

  if (dismissed) {
    return (
      <div className="my-2 px-3 py-2 border border-ok/30 bg-ok/5 text-xs text-ok">
        {t("messagecontent.PluginEnabledInlineNotice", {
          defaultValue: "{{name}} is enabled.",
          name: plugin?.name ?? pluginId,
        })}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="my-2 px-3 py-2 border border-border bg-card text-xs text-muted italic">
        {t("messagecontent.LoadingConfiguration", {
          defaultValue: "Loading {{pluginId}} configuration...",
          pluginId,
        })}
      </div>
    );
  }

  if (!plugin) {
    return (
      <div className="my-2 px-3 py-2 border border-border bg-card text-xs text-muted italic">
        {t("messagecontent.PluginNotFound", {
          defaultValue: 'Plugin "{{pluginId}}" not found.',
          pluginId,
        })}
      </div>
    );
  }

  const isEnabled = plugin.enabled;

  return (
    <div className="my-2 border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-bg-hover">
        <div className="flex items-center gap-2 text-xs font-bold text-txt">
          {plugin.icon ? (
            <span className="text-sm">{plugin.icon}</span>
          ) : (
            <span className="text-sm opacity-60">{"\u2699\uFE0F"}</span>
          )}
          <span>
            {t("messagecontent.PluginConfigurationTitle", {
              defaultValue: "{{name}} Configuration",
              name: plugin.name,
            })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {plugin.configured && (
            <span className="text-2xs text-ok font-medium">
              {t("config-field.Configured")}
            </span>
          )}
          <span
            className={`text-2xs font-medium ${isEnabled ? "text-ok" : "text-muted"}`}
          >
            {isEnabled
              ? t("common.active", {
                  defaultValue: "Active",
                })
              : t("common.inactive", {
                  defaultValue: "Inactive",
                })}
          </span>
        </div>
      </div>

      {/* Form — always shown so user can configure before enabling */}
      {schema && hasConfigurableParams ? (
        <div className="p-3">
          <ConfigRenderer
            schema={schema}
            hints={hints}
            values={mergedValues}
            setKeys={setKeys}
            registry={defaultRegistry}
            pluginId={plugin.id}
            onChange={handleChange}
          />
        </div>
      ) : (
        <div className="px-3 py-2 text-xs text-muted italic">
          {t("messagecontent.NoConfigurablePara")}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        {schema && hasConfigurableParams && (
          <Button
            variant="default"
            size="sm"
            className="px-4 py-1.5 h-7 text-xs shadow-sm bg-accent text-accent-fg hover:opacity-90 disabled:opacity-40"
            onClick={handleSave}
            disabled={saving || enabling || Object.keys(values).length === 0}
          >
            {saving
              ? t("common.saving", {
                  defaultValue: "Saving...",
                })
              : t("common.save")}
          </Button>
        )}

        {!isEnabled ? (
          <Button
            variant="outline"
            size="sm"
            className="px-4 py-1.5 h-7 text-xs border-ok/50 text-ok bg-ok/5 hover:bg-ok/10 hover:text-ok disabled:opacity-40"
            onClick={() => void handleToggle(true)}
            disabled={enabling || saving}
          >
            {enabling
              ? t("messagecontent.Enabling", {
                  defaultValue: "Turning on...",
                })
              : t("messagecontent.EnablePlugin", {
                  defaultValue: "Enable plugin",
                })}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="px-4 py-1.5 h-7 text-xs text-muted hover:border-danger hover:text-danger disabled:opacity-40"
            onClick={() => void handleToggle(false)}
            disabled={enabling || saving}
          >
            {enabling
              ? t("messagecontent.Disabling", {
                  defaultValue: "Turning off...",
                })
              : t("common.disable", {
                  defaultValue: "Disable",
                })}
          </Button>
        )}

        {saved && <span className="text-xs text-ok">{t("common.saved")}</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </div>
  );
}

// ── UiSpec block ────────────────────────────────────────────────────

function UiSpecBlock({ spec, raw }: { spec: UiSpec; raw: string }) {
  const { t } = useApp();
  const { sendActionMessage } = useApp();
  const [showRaw, setShowRaw] = useState(false);

  const handleAction = useCallback(
    (action: string, params?: Record<string, unknown>) => {
      // Plugin actions are handled directly via the API instead of
      // being sent back as chat messages.
      if (action === "plugin:save" && params?.pluginId) {
        const pluginId = String(params.pluginId);
        const config: Record<string, string> = {};
        // Collect all config.* state values
        if (params) {
          for (const [key, value] of Object.entries(params)) {
            if (
              key.startsWith("config.") &&
              typeof value === "string" &&
              value.trim()
            ) {
              config[key.slice(7)] = value.trim();
            }
          }
        }
        void client
          .updatePlugin(pluginId, { config })
          .then(() =>
            sendActionMessage(
              `[Plugin ${pluginId} configuration saved successfully]`,
            ),
          )
          .catch((err: unknown) =>
            sendActionMessage(
              `[Failed to save plugin config: ${err instanceof Error ? err.message : "unknown error"}]`,
            ),
          );
        return;
      }
      if (action === "plugin:enable" && params?.pluginId) {
        void client
          .updatePlugin(String(params.pluginId), { enabled: true })
          .then(() =>
            sendActionMessage(
              `[Plugin ${params.pluginId} enabled. Restart required.]`,
            ),
          )
          .catch(() => sendActionMessage(`[Failed to enable plugin]`));
        return;
      }
      if (action === "plugin:test" && params?.pluginId) {
        void sendActionMessage(`[Testing ${params.pluginId} connection...]`);
        return;
      }
      if (action === "plugin:configure" && params?.pluginId) {
        void sendActionMessage(
          `Please show me the configuration form for the ${params.pluginId} plugin`,
        );
        return;
      }
      const paramsStr = params ? ` ${JSON.stringify(params)}` : "";
      void sendActionMessage(`[action:${action}]${paramsStr}`);
    },
    [sendActionMessage],
  );

  return (
    <div className="my-2 border border-border overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-bg-hover">
        <span className="text-2xs font-semibold text-muted uppercase tracking-wider">
          {t("messagecontent.InteractiveUI")}
        </span>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-2xs text-txt hover:underline decoration-accent/50 underline-offset-2"
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw
            ? t("messagecontent.HideJson", {
                defaultValue: "Hide JSON",
              })
            : t("messagecontent.ViewJson", {
                defaultValue: "View JSON",
              })}
        </Button>
      </div>
      {showRaw && (
        <div className="px-3 py-2 bg-card overflow-x-auto">
          <pre className="text-2xs text-muted font-mono whitespace-pre-wrap break-words m-0">
            {raw}
          </pre>
        </div>
      )}
      <div className="p-3">
        <UiRenderer spec={spec} onAction={handleAction} />
      </div>
    </div>
  );
}

function sensitiveRequestStatusLabel(
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

function SensitiveRequestBlock({
  request,
}: {
  request: NonNullable<ConversationMessage["secretRequest"]>;
}) {
  const [status, setStatus] = useState(request.status);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStatus(request.status);
    setValues({});
    setSaving(false);
    setError(null);
  }, [request]);

  const fields = request.form?.fields ?? [];
  const canCollectSecret =
    status === "pending" &&
    request.form?.kind === "secret" &&
    request.delivery?.canCollectValueInCurrentChannel === true &&
    fields.length > 0;

  const canSubmit = fields.every((field) => {
    if (!field.required) return true;
    return (values[field.name] ?? "").trim().length > 0;
  });

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canCollectSecret || !canSubmit) return;
      setSaving(true);
      setError(null);
      try {
        const secrets: Record<string, string> = {};
        for (const field of fields) {
          const value = values[field.name];
          if (value != null && value !== "") {
            secrets[field.name] = value;
          }
        }
        await client.updateSecrets(secrets);
        setValues({});
        setStatus("saved");
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Could not save secret.",
        );
        setStatus("failed");
      } finally {
        setSaving(false);
      }
    },
    [canCollectSecret, canSubmit, fields, values],
  );

  return (
    <div
      data-testid="sensitive-request"
      className="my-2 border border-border bg-card p-3 text-sm space-y-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium">{request.key}</div>
        <div
          data-testid="sensitive-request-status"
          className="text-xs text-muted"
        >
          {sensitiveRequestStatusLabel(status)}
        </div>
      </div>
      {request.reason && (
        <div className="text-xs text-muted">{request.reason}</div>
      )}
      {request.delivery?.instruction && (
        <div className="text-xs text-muted">{request.delivery.instruction}</div>
      )}
      {canCollectSecret && (
        <form className="space-y-3" onSubmit={handleSubmit}>
          {fields.map((field) => {
            const label = field.label ?? field.name;
            return (
              <label key={field.name} className="block text-xs space-y-1">
                <span className="font-medium">{label}</span>
                <input
                  aria-label={label}
                  className="w-full border border-border bg-bg px-2 py-1.5 text-sm"
                  type={field.input === "secret" ? "password" : "text"}
                  value={values[field.name] ?? ""}
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value;
                    setValues((previous) => ({
                      ...previous,
                      [field.name]: nextValue,
                    }));
                  }}
                  required={field.required}
                />
              </label>
            );
          })}
          <div className="text-xs text-muted">
            The value will not be sent as a chat message.
          </div>
          <Button type="submit" size="sm" disabled={saving || !canSubmit}>
            {saving ? "Saving..." : (request.form?.submitLabel ?? "Save")}
          </Button>
        </form>
      )}
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────

export function MessageContent({
  message,
  analysisMode = false,
}: MessageContentProps) {
  const app = useApp();
  const { sendActionMessage } = app;
  const [localDownloadState, setLocalDownloadState] = useState<
    "idle" | "busy" | "queued" | "failed"
  >("idle");
  const [localDownloadError, setLocalDownloadError] = useState<string | null>(
    null,
  );

  // Parse segments — memoize to avoid re-parsing on every render
  const segments = useMemo(() => {
    try {
      return parseSegments(message.text, analysisMode);
    } catch {
      // If parsing fails, just show plain text
      return [{ kind: "text" as const, text: message.text }];
    }
  }, [message.text, analysisMode]);

  const handleChoice = useCallback(
    (value: string) => {
      void sendActionMessage(value);
    },
    [sendActionMessage],
  );

  const permissionRegistry = useMemo(
    () => createClientPermissionsRegistry(client),
    [],
  );

  const handlePermissionFallback = useCallback(
    (feature: string, permission: string) => {
      void sendActionMessage(
        `__permission_card__:use_fallback feature=${feature} permission=${permission}`,
      );
    },
    [sendActionMessage],
  );

  const handlePermissionGranted = useCallback(
    (feature: string, permission: string) => {
      void sendActionMessage(
        `__permission_card__:granted feature=${feature} permission=${permission}`,
      );
    },
    [sendActionMessage],
  );

  const handleOpenSettings = useCallback(() => {
    app.setTab?.("settings");
  }, [app.setTab]);

  const handleDownloadDefaultLocalModel = useCallback(async () => {
    const modelId = message.localInference?.modelId;
    if (!modelId) {
      handleOpenSettings();
      return;
    }
    setLocalDownloadState("busy");
    setLocalDownloadError(null);
    try {
      await client.startLocalInferenceDownload(modelId);
      setLocalDownloadState("queued");
    } catch (error) {
      setLocalDownloadError(
        error instanceof Error ? error.message : "Failed to start download",
      );
      setLocalDownloadState("failed");
    }
  }, [handleOpenSettings, message.localInference?.modelId]);

  if (message.secretRequest) {
    return <SensitiveRequestBlock request={message.secretRequest} />;
  }

  if (
    message.localInference &&
    message.localInference.status !== "ready" &&
    message.localInference.status !== "routing"
  ) {
    const status = message.localInference.status;
    const downloading = status === "downloading" || status === "loading";
    const canStartDownload = Boolean(message.localInference.modelId);
    return (
      <div className="rounded-md border border-warn/30 bg-warn/5 p-3 text-sm">
        <div className="mb-1 font-medium">
          {downloading
            ? "Local model download in progress"
            : "Local model required"}
        </div>
        <div className="mb-2 whitespace-pre-wrap text-muted">
          {message.text}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={handleDownloadDefaultLocalModel}
            disabled={downloading || localDownloadState === "busy"}
          >
            {downloading
              ? "Downloading"
              : localDownloadState === "busy"
                ? "Starting..."
                : localDownloadState === "queued"
                  ? "Download queued"
                  : "Download default model"}
          </Button>
          {!canStartDownload ? (
            <Button type="button" size="sm" onClick={handleOpenSettings}>
              Open Local Models
            </Button>
          ) : null}
        </div>
        {localDownloadError ? (
          <div className="mt-2 text-xs text-danger">{localDownloadError}</div>
        ) : null}
      </div>
    );
  }

  // The server flags failed assistant turns with `failureKind`. For
  // `no_provider` specifically the user can't make progress without
  // wiring up a provider, so render a structured gate (banner + CTA)
  // instead of the fallback text — clicking jumps to Settings where
  // ProviderSwitcher lives. Other failure kinds (insufficient_credits,
  // provider_issue) still render as normal text bubbles; the user has
  // separate, clearer in-product affordances for those (Cloud billing
  // banner, retry).
  if (message.failureKind === "no_provider") {
    return (
      <div className="border border-warn/30 bg-warn/5 rounded-md p-3 text-sm">
        <div className="font-medium mb-1">Connect a provider to chat</div>
        <div className="text-muted whitespace-pre-wrap mb-2">
          {message.text}
        </div>
        <Button type="button" size="sm" onClick={handleOpenSettings}>
          Open Settings
        </Button>
      </div>
    );
  }

  // Fast path: single plain-text segment (most messages)
  if (segments.length === 1 && segments[0].kind === "text") {
    return <div className="whitespace-pre-wrap">{segments[0].text}</div>;
  }

  return (
    <div>
      {(() => {
        const keyCounts = new Map<string, number>();
        const nextKey = (base: string) => {
          const nextCount = (keyCounts.get(base) ?? 0) + 1;
          keyCounts.set(base, nextCount);
          return `${base}:${nextCount}`;
        };

        return segments.map((seg) => {
          const baseKey =
            seg.kind === "text"
              ? `text:${seg.text.slice(0, 80)}`
              : seg.kind === "config"
                ? `config:${seg.pluginId}`
                : seg.kind === "choice"
                  ? `choice:${seg.id}`
                  : seg.kind === "permission"
                    ? `permission:${seg.payload.feature}`
                    : seg.kind === "analysis-xml"
                      ? `analysis:${seg.tag}`
                      : `ui:${seg.raw.slice(0, 80)}`;
          const segmentKey = nextKey(baseKey);

          switch (seg.kind) {
            case "text":
              return (
                <div key={segmentKey} className="whitespace-pre-wrap">
                  {seg.text}
                </div>
              );
            case "analysis-xml":
              return (
                <div
                  key={segmentKey}
                  className="my-2 border border-accent/20 rounded bg-accent/5 overflow-hidden"
                >
                  <div className="bg-accent/10 px-3 py-1 text-xs font-mono font-bold text-accent uppercase tracking-wider">
                    &lt;{seg.tag}&gt;
                  </div>
                  <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words text-muted m-0 overflow-x-auto">
                    {seg.content.trim()}
                  </pre>
                </div>
              );
            case "config":
              if (!isSafeNormalizedPluginId(normalizePluginId(seg.pluginId))) {
                return null;
              }
              return (
                <InlinePluginConfig key={segmentKey} pluginId={seg.pluginId} />
              );
            case "ui-spec":
              return (
                <UiSpecBlock key={segmentKey} spec={seg.spec} raw={seg.raw} />
              );
            case "choice":
              return (
                <ChoiceWidget
                  key={segmentKey}
                  id={seg.id}
                  scope={seg.scope}
                  options={seg.options}
                  onChoose={handleChoice}
                />
              );
            case "permission":
              return (
                <PermissionCard
                  key={segmentKey}
                  permission={seg.payload.permission}
                  reason={seg.payload.reason}
                  feature={seg.payload.feature}
                  fallbackOffered={seg.payload.fallbackOffered}
                  fallbackLabel={seg.payload.fallbackLabel}
                  registry={permissionRegistry}
                  onOpenSettings={(permission) =>
                    client.openPermissionSettings(permission)
                  }
                  onFallback={({ feature, permission }) =>
                    handlePermissionFallback(feature, permission)
                  }
                  onGranted={() =>
                    handlePermissionGranted(
                      seg.payload.feature,
                      seg.payload.permission,
                    )
                  }
                />
              );
            default:
              return null;
          }
        });
      })()}
      {analysisMode && message.actionName && (
        <div className="my-2 border border-purple-500/20 rounded bg-purple-500/5 overflow-hidden">
          <div className="bg-purple-500/10 px-3 py-1 text-xs font-mono font-bold text-purple-500 uppercase tracking-wider">
            ACTION TAKEN
          </div>
          <div className="px-3 py-2 text-xs font-mono text-muted space-y-1">
            {message.actionName}
          </div>
        </div>
      )}
      {analysisMode &&
        message.actionCallbackHistory &&
        message.actionCallbackHistory.length > 0 && (
          <div className="my-2 border border-blue-500/20 rounded bg-blue-500/5 overflow-hidden">
            <div className="bg-blue-500/10 px-3 py-1 text-xs font-mono font-bold text-blue-500 uppercase tracking-wider">
              ACTION CALLBACK HISTORY
            </div>
            <div className="px-3 py-2 text-xs font-mono text-muted space-y-1">
              {(() => {
                const occurrence = new Map<string, number>();
                return message.actionCallbackHistory.map((log) => {
                  const n = occurrence.get(log) ?? 0;
                  occurrence.set(log, n + 1);
                  return (
                    <div
                      key={`${message.id}:action-callback:${n}:${log}`}
                      className="break-words border-b border-blue-500/10 pb-1 last:border-0 last:pb-0"
                    >
                      {log}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}
    </div>
  );
}
