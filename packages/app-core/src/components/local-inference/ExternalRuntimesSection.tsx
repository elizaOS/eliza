/**
 * Per-backend cards in the Local models hub (reachability, URLs, refresh).
 *
 * WHY: Operator copy + badges stay aligned with `external-hub-probe-status` and the same probe rows
 * that feed router “external ready” (`external-llm-runtime.ts`). Users fix env mismatches from here;
 * drift between UI and router probes would be un-debuggable.
 */
import { Button, Input, Label, TooltipProvider } from "@elizaos/ui";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api";
import type {
  ExternalLlmAutodetectFocus,
  ExternalLlmRuntimeRow,
} from "../../api/client-local-inference";
import {
  externalHubProbeStatusBadgeClass,
  getExternalHubProbeBadgeLabel,
  getExternalHubProbeBadgeTooltip,
  getExternalHubProbeStatus,
} from "../../services/local-inference/external-hub-probe-status";
import { resolveExternalLlmAutodetectUi } from "../../services/local-inference/external-llm-autodetect";
import {
  formatExternalProbeModelInventoryShort,
  probeModelIdsForHubStatusLine,
  summarizeExternalProbeModelIds,
} from "../../services/local-inference/external-probe-model-buckets";
import { sortExternalRuntimes } from "../../services/local-inference/sort-external-runtimes";
import { useApp } from "../../state";
import {
  EXTERNAL_RUNTIME_ENV_VARS,
  readRuntimeUrlFromVars,
} from "./external-runtime-env-keys";
import { InferenceHelpHint } from "./InferenceHelpHint";

const ENV_HINTS: Record<
  ExternalLlmRuntimeRow["id"],
  { title: string; lines: string[] }
> = {
  ollama: {
    title: "Use with Milady",
    lines: [
      "Ollama is part of local AI here: an optional HTTP stack next to Milady in-app GGUF. Milady auto-enables @elizaos/plugin-ollama when OLLAMA_BASE_URL is set.",
      "Router probes /api/tags (library) and /api/ps (models resident in RAM). The hub shows Working only when /api/ps shows ≥1 runner (or /api/ps could not be parsed); otherwise Idle with models on disk is normal.",
      "Hub status line counts pulled models only (chat vs embedding heuristics; vision/audio omitted).",
    ],
  },
  lmstudio: {
    title: "Use with Milady",
    lines: [
      "LM Studio is part of local AI: a desktop host for OpenAI-compatible /v1. Set OPENAI_BASE_URL to …/v1 and OPENAI_API_KEY for @elizaos/plugin-openai chat (separate from the probe host above).",
      "Router: /v1/models plus GET /api/v1/models loaded_instances when available.",
      "Optional: OPENAI_EXTRA_BODY_JSON, OPENAI_REASONING_EFFORT for model-native options.",
      "Hub status line lists /v1/models ids (chat vs embedding heuristics; vision/audio omitted).",
    ],
  },
  vllm: {
    title: "Use with Milady",
    lines: [
      "vLLM is part of local AI: point OPENAI_BASE_URL at the same OpenAI root …/v1 with @elizaos/plugin-openai.",
      "Router uses GET /v1/models (listed ids).",
      "Hub status line counts pulled models only (chat vs embedding heuristics; vision/audio omitted).",
    ],
  },
  jan: {
    title: "Use with Milady",
    lines: [
      "Jan is part of local AI: match JAN_API_KEY Bearer to Jan → Local API Server; OPENAI_API_KEY for plugin-openai.",
      "Set OPENAI_BASE_URL to …/v1 for chat. Router: GET /v1/models.",
      "Hub status line counts pulled models only (chat vs embedding heuristics; vision/audio omitted).",
    ],
  },
};

function readVars(cfg: Record<string, unknown>): Record<string, string> {
  const vars =
    ((cfg.env as Record<string, unknown> | undefined)?.vars as
      | Record<string, unknown>
      | undefined) ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function statusLabel(row: ExternalLlmRuntimeRow): string {
  if (!row.reachable) return row.error ?? "Not reachable";
  if (!row.hasDownloadedModels) {
    return "Reachable — no model ids listed at this URL";
  }

  const statusIds = probeModelIdsForHubStatusLine(row);
  const counts = summarizeExternalProbeModelIds(statusIds);
  let inv = formatExternalProbeModelInventoryShort(counts);
  if (!inv && statusIds.length > 0) {
    inv = `${statusIds.length} id(s) (counted as chat)`;
  }
  if (!inv) {
    inv = "no model ids";
  }
  const base = `At this URL — ${inv}`;

  if (
    row.id === "ollama" &&
    typeof row.ollamaRunningModelCount === "number" &&
    row.ollamaRunningModelCount > 0
  ) {
    return `${base} · ${row.ollamaRunningModelCount} loaded in RAM`;
  }
  if (
    row.id === "lmstudio" &&
    typeof row.lmStudioLoadedInstanceCount === "number" &&
    row.lmStudioLoadedInstanceCount > 0
  ) {
    return `${base} · ${row.lmStudioLoadedInstanceCount} loaded in LM Studio`;
  }
  if (row.routerInferenceReady) {
    return `${base} · may route away from in-app GGUF`;
  }
  if (
    row.id === "lmstudio" &&
    row.hasDownloadedModels &&
    row.lmStudioLoadedInstanceCount === 0
  ) {
    return `${base} · idle (load a model in LM Studio — eject clears router-ready)`;
  }
  if (row.id === "ollama" && row.hasDownloadedModels) {
    return `${base} · idle (load a model in Ollama to mark router-ready)`;
  }
  return base;
}

/**
 * Surfaces optional local AI engine HTTP stacks on the Local models page
 * alongside Milady GGUF. Each card edits the probe base URL in `config.env.vars`.
 */
export function ExternalRuntimesSection({
  backends,
  onRefresh,
  busy,
  onExternalLlmAutodetectFocusChange,
}: {
  backends: ExternalLlmRuntimeRow[];
  onRefresh: () => void | Promise<void>;
  busy?: boolean;
  /** Fired after the user saves “Local AI engine preference” so parents can sync UI (e.g. embedding slot). */
  onExternalLlmAutodetectFocusChange?: (
    focus: ExternalLlmAutodetectFocus,
  ) => void;
}) {
  const { setActionNotice, t } = useApp();
  const [urlDrafts, setUrlDrafts] = useState<
    Partial<Record<ExternalLlmRuntimeRow["id"], string>>
  >({});
  const [savingId, setSavingId] = useState<ExternalLlmRuntimeRow["id"] | null>(
    null,
  );
  const [autodetectFocus, setAutodetectFocus] =
    useState<ExternalLlmAutodetectFocus>("any");
  const [focusSaving, setFocusSaving] = useState(false);

  const displayBackends = useMemo(
    () => sortExternalRuntimes(backends),
    [backends],
  );

  const refreshAutodetectFocus = useCallback(async () => {
    try {
      const { preferences } = await client.getLocalInferenceRouting();
      setAutodetectFocus(preferences.externalLlmAutodetectFocus ?? "any");
    } catch {
      /* keep previous */
    }
  }, []);

  useEffect(() => {
    void refreshAutodetectFocus();
  }, [refreshAutodetectFocus]);

  useEffect(() => {
    if (displayBackends.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const cfg = (await client.getConfig()) as Record<string, unknown>;
        if (cancelled) return;
        const vars = readVars(cfg);
        const next: Partial<Record<ExternalLlmRuntimeRow["id"], string>> = {};
        for (const row of displayBackends) {
          next[row.id] = readRuntimeUrlFromVars(vars, row);
        }
        setUrlDrafts(next);
      } catch {
        setUrlDrafts(
          Object.fromEntries(
            displayBackends.map((r) => [r.id, r.endpoint]),
          ) as Partial<Record<ExternalLlmRuntimeRow["id"], string>>,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [displayBackends]);

  const handleSaveUrl = useCallback(
    async (id: ExternalLlmRuntimeRow["id"]) => {
      const primary = EXTERNAL_RUNTIME_ENV_VARS[id].primary;
      const val = (urlDrafts[id] ?? "").trim();
      setSavingId(id);
      try {
        await client.updateConfig({
          env: { vars: { [primary]: val } },
        });
        setActionNotice("Probe URL saved", "success", 2000);
        await onRefresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionNotice(`Save failed: ${msg}`, "error", 5000);
      } finally {
        setSavingId(null);
      }
    },
    [onRefresh, setActionNotice, urlDrafts],
  );

  const saveAutodetectFocus = useCallback(
    async (next: ExternalLlmAutodetectFocus) => {
      setFocusSaving(true);
      try {
        const { preferences } =
          await client.setLocalInferenceExternalLlmAutodetectFocus(next);
        const resolved = preferences.externalLlmAutodetectFocus ?? "any";
        setAutodetectFocus(resolved);
        onExternalLlmAutodetectFocusChange?.(resolved);
        await refreshAutodetectFocus();
        setActionNotice("Autodetect preference saved", "success", 2000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionNotice(`Autodetect save failed: ${msg}`, "error", 5000);
      } finally {
        setFocusSaving(false);
      }
    },
    [
      onExternalLlmAutodetectFocusChange,
      refreshAutodetectFocus,
      setActionNotice,
    ],
  );

  return (
    <TooltipProvider delayDuration={200}>
      <section className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-4">
        <header className="flex justify-end">
          <InferenceHelpHint aria-label="About Local AI engine probe cards">
            <p>
              {t("settings.sharedLocalAiRuntimes.hintEnginesIntro", {
                defaultValue:
                  "Optional HTTP stacks (Ollama, LM Studio, vLLM, Jan, …) next to Milady in-app GGUF. Each card is one probe URL. Use engine preference below when several hubs are ready.",
              })}
            </p>
            <p>
              {t("settings.sharedLocalAiRuntimes.hintEnginesRoutingBefore", {
                defaultValue:
                  "For OPENAI_BASE_URL / API keys used by @elizaos/plugin-openai, go to ",
              })}
              <a
                href="#ai-model"
                className="text-primary underline-offset-2 hover:underline"
              >
                {t("settings.sections.aimodel.label", {
                  defaultValue: "AI Models",
                })}
              </a>
              {t("settings.sharedLocalAiRuntimes.hintEnginesRoutingAfter", {
                defaultValue: ".",
              })}
            </p>
          </InferenceHelpHint>
        </header>

        <div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-card/60 p-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Label
              htmlFor="local-ai-engine-preference"
              className="text-xs font-medium text-foreground"
            >
              {"Local AI engine preference"}
            </Label>
            <InferenceHelpHint aria-label="How automatic vs pinned works">
              <p>
                {t("settings.sharedLocalAiRuntimes.hintAutodetectPref", {
                  defaultValue:
                    "Automatic follows the probe cards in display order (left to right). The menu shows the first that is Working (ready for routing); if several are, any still qualifies until you pick Only … for one stack. Cards use badges: Not detected (unreachable), Detected (up but not router-ready), Working (router-ready).",
                })}
              </p>
              <p>
                {t("settings.sharedLocalAiRuntimes.hintAutodetectMilady", {
                  defaultValue:
                    "Only Milady GGUF means in-process llama.cpp (Milady-local) is your chosen engine for this gate: HTTP hubs are ignored so their probes never mark “external ready” and do not suppress Milady’s GGUF on that basis.",
                })}
              </p>
            </InferenceHelpHint>
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:min-w-[15.5rem]">
            <select
              id="local-ai-engine-preference"
              className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-xs sm:max-w-xs"
              disabled={Boolean(busy) || focusSaving}
              value={autodetectFocus}
              onChange={(e) => {
                const v = e.target.value as ExternalLlmAutodetectFocus;
                void saveAutodetectFocus(v);
              }}
            >
              <option value="any">
                {
                  resolveExternalLlmAutodetectUi(displayBackends)
                    .automaticSelectLabel
                }
              </option>
              <option value="milady-gguf">
                {"Only Milady GGUF (in-process llama.cpp)"}
              </option>
              {displayBackends.map((b) => (
                <option key={b.id} value={b.id}>
                  {`Only ${b.displayName}`}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-9 w-9 shrink-0 rounded-md"
              disabled={Boolean(busy)}
              aria-label="Refresh hub status"
              onClick={() => void onRefresh()}
            >
              <RefreshCw
                className={`h-4 w-4 ${busy ? "animate-spin" : ""}`}
                aria-hidden
              />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {displayBackends.map((row) => {
            const hint = ENV_HINTS[row.id];
            const meta = EXTERNAL_RUNTIME_ENV_VARS[row.id];
            const draftFromState = urlDrafts[row.id];
            const draft =
              draftFromState !== undefined ? draftFromState : row.endpoint;
            const isSaving = savingId === row.id;
            return (
              <div
                key={row.id}
                className="flex flex-col gap-2 rounded-lg border border-border/50 bg-card/80 p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-sm">
                    {row.displayName}
                  </span>
                  <span
                    className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${externalHubProbeStatusBadgeClass(
                      getExternalHubProbeStatus(row),
                    )}`}
                    title={getExternalHubProbeBadgeTooltip(row)}
                  >
                    {getExternalHubProbeBadgeLabel(row)}
                  </span>
                  <InferenceHelpHint
                    aria-label={`${row.displayName} setup hints`}
                  >
                    <p className="font-medium text-txt-strong">{hint.title}</p>
                    <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                      {hint.lines.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </InferenceHelpHint>
                </div>

                <div className="space-y-1">
                  <Label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {meta.primary}
                  </Label>
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end">
                    <Input
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={draft}
                      onChange={(e) =>
                        setUrlDrafts((prev) => ({
                          ...prev,
                          [row.id]: e.target.value,
                        }))
                      }
                      className="h-8 min-w-0 flex-1 font-mono text-[11px]"
                      placeholder={row.endpoint}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="h-8 shrink-0 rounded-lg sm:w-auto w-full"
                      disabled={busy || isSaving}
                      onClick={() => void handleSaveUrl(row.id)}
                    >
                      {isSaving ? "Saving…" : "Save"}
                    </Button>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  {statusLabel(row)}
                </p>
              </div>
            );
          })}
        </div>
      </section>
    </TooltipProvider>
  );
}
