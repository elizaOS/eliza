import { ELIZA_CLOUD_PUBLIC_HOST } from "@elizaos/shared/eliza-cloud-presets";
import { TooltipProvider } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api";
import type {
  AgentModelSlot,
  ExternalLlmAutodetectFocus,
  InstalledModel,
  ModelAssignments,
  ModelHubSnapshot,
} from "../../api/client-local-inference";
import {
  embeddingModelIdsFromExternalRow,
  probeModelIdsForEmbeddingListing,
  resolveBackendRowForOpenAiEmbeddingListing,
} from "../../services/local-inference/embedding-external-stack";
import {
  type OllamaPullProgressSnapshot,
  pullOllamaModel,
  SUGGESTED_OLLAMA_EMBEDDING_MODEL,
} from "../../services/local-inference/ollama-pull-model";
import { sortExternalRuntimes } from "../../services/local-inference/sort-external-runtimes";
import { useApp } from "../../state";
import { EmbeddingCatalogModelField } from "./EmbeddingCatalogModelField";
import { EmbeddingGgufOffer } from "./EmbeddingGgufOffer";
import { ExternalEmbeddingOpenAiField } from "./ExternalEmbeddingOpenAiField";
import {
  installedMiladyEmbeddingFromCatalog,
  summarizeEmbeddingInUse,
} from "./hub-utils";
import { InferenceHelpHint } from "./InferenceHelpHint";
import { OllamaEmbeddingPullOffer } from "./OllamaEmbeddingPullOffer";

const SLOT: AgentModelSlot = "TEXT_EMBEDDING";

function readEnvVarsFromConfig(
  cfg: Record<string, unknown>,
): Record<string, string> {
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

/**
 * Shown under Eliza Cloud when “Use local embedding” is on.
 *
 * - **Only Milady GGUF:** curated Milady-local GGUF download + pin (same as the
 *   Local models hub embedding path).
 * - **Automatic / pinned engine:** lists embedding-shaped model ids from the hub
 *   probe for the active stack and edits `OPENAI_EMBEDDING_MODEL` so the
 *   OpenAI-compatible embedding plugin matches that host.
 *   For **Ollama** with no such ids, offers a one-click **pull** of a small default
 *   embedding model (same spirit as the Milady GGUF download card).
 */
export function LocalEmbeddingCloudStrip({
  hub,
  onRefreshHub,
  hubBusy = false,
  routingRefreshSignal = 0,
}: {
  hub?: ModelHubSnapshot | null;
  onRefreshHub?: () => void | Promise<void>;
  hubBusy?: boolean;
  routingRefreshSignal?: number;
}) {
  const { setActionNotice, t } = useApp();
  const [externalLlmFocus, setExternalLlmFocus] =
    useState<ExternalLlmAutodetectFocus | null>(null);
  const [assignments, setAssignments] = useState<ModelAssignments>({});
  const [installed, setInstalled] = useState<InstalledModel[]>([]);
  const [openAiEmbeddingModel, setOpenAiEmbeddingModel] = useState("");
  const [openAiBaseUrl, setOpenAiBaseUrl] = useState("");
  const [busyAssignment, setBusyAssignment] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [ollamaPullBusy, setOllamaPullBusy] = useState(false);
  const [ollamaPullProgress, setOllamaPullProgress] =
    useState<OllamaPullProgressSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [routing, assignRes, installedRes, cfg] = await Promise.all([
        client.getLocalInferenceRouting(),
        client.getLocalInferenceAssignments(),
        client.getLocalInferenceInstalled(),
        client.getConfig(),
      ]);
      setExternalLlmFocus(
        routing.preferences.externalLlmAutodetectFocus ?? "any",
      );
      setAssignments(assignRes.assignments);
      setInstalled(installedRes.models ?? []);
      const vars = readEnvVarsFromConfig(cfg as Record<string, unknown>);
      setOpenAiEmbeddingModel(vars.OPENAI_EMBEDDING_MODEL?.trim() ?? "");
      setOpenAiBaseUrl(vars.OPENAI_BASE_URL?.trim() ?? "");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (routingRefreshSignal < 1) return;
    void refresh();
  }, [routingRefreshSignal, refresh]);

  useEffect(() => {
    if (hub?.installed) setInstalled(hub.installed);
    if (hub?.assignments)
      setAssignments((prev) => ({ ...prev, ...hub.assignments }));
  }, [hub?.installed, hub?.assignments]);

  const handleAssignment = useCallback(async (modelId: string | null) => {
    setBusyAssignment(true);
    try {
      const res = await client.setLocalInferenceAssignment(SLOT, modelId);
      setAssignments(res.assignments);
    } finally {
      setBusyAssignment(false);
    }
  }, []);

  const handleEmbeddingDownload = useCallback(
    async (modelId: string) => {
      setDownloadBusy(true);
      try {
        await client.startLocalInferenceDownload(modelId);
        setActionNotice("Embedding download started", "success", 2500);
        await onRefreshHub?.();
        await refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionNotice(`Download failed: ${msg}`, "error", 5000);
      } finally {
        setDownloadBusy(false);
      }
    },
    [onRefreshHub, refresh, setActionNotice],
  );

  const handleEmbeddingCancel = useCallback(
    async (modelId: string) => {
      setDownloadBusy(true);
      try {
        await client.cancelLocalInferenceDownload(modelId);
        await onRefreshHub?.();
        await refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionNotice(`Cancel failed: ${msg}`, "error", 4000);
      } finally {
        setDownloadBusy(false);
      }
    },
    [onRefreshHub, refresh, setActionNotice],
  );

  const catalog = hub?.catalog ?? [];
  const pickerInstalled = hub?.installed ?? installed;
  const assignmentMerged = hub?.assignments?.[SLOT] ?? assignments[SLOT] ?? "";

  const embeddingPickerModels = useMemo(() => {
    if (!catalog.length) return [];
    return installedMiladyEmbeddingFromCatalog(pickerInstalled, catalog);
  }, [pickerInstalled, catalog]);

  const embeddingPickerIds = useMemo(
    () => new Set(embeddingPickerModels.map((m) => m.id)),
    [embeddingPickerModels],
  );

  const selectValue = embeddingPickerIds.has(assignmentMerged)
    ? assignmentMerged
    : "";

  const embeddingInUseMilady = useMemo(() => {
    if (externalLlmFocus !== "milady-gguf") return null;
    return summarizeEmbeddingInUse({
      assignmentId: assignmentMerged,
      catalog,
      installedForPicker: pickerInstalled,
      active: hub?.active ?? {
        modelId: null,
        loadedAt: null,
        status: "idle",
      },
    });
  }, [
    externalLlmFocus,
    assignmentMerged,
    catalog,
    pickerInstalled,
    hub?.active,
  ]);

  const backendsSorted = useMemo(
    () => sortExternalRuntimes(hub?.externalRuntimes ?? []),
    [hub?.externalRuntimes],
  );

  const embeddingStackRow = useMemo(() => {
    if (externalLlmFocus === null || externalLlmFocus === "milady-gguf")
      return null;
    return resolveBackendRowForOpenAiEmbeddingListing(
      externalLlmFocus,
      backendsSorted,
      openAiBaseUrl,
    );
  }, [externalLlmFocus, backendsSorted, openAiBaseUrl]);

  const handleOllamaPullSuggestedEmbedding = useCallback(async () => {
    const row = embeddingStackRow;
    if (row?.id !== "ollama" || !row.reachable || !row.endpoint?.trim()) {
      setActionNotice("Ollama is not reachable from the probe.", "error", 4000);
      return;
    }
    setOllamaPullProgress(null);
    setOllamaPullBusy(true);
    try {
      await pullOllamaModel(row.endpoint, SUGGESTED_OLLAMA_EMBEDDING_MODEL, {
        onProgress: (p) => setOllamaPullProgress(p),
      });
      setActionNotice(
        `Ollama pulled ${SUGGESTED_OLLAMA_EMBEDDING_MODEL}. Refresh Local AI (↻) if ids do not appear yet.`,
        "success",
        5000,
      );
      await onRefreshHub?.();
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionNotice(
        `Ollama pull failed: ${msg}. You can run: ollama pull ${SUGGESTED_OLLAMA_EMBEDDING_MODEL}`,
        "error",
        8000,
      );
    } finally {
      setOllamaPullBusy(false);
      setOllamaPullProgress(null);
    }
  }, [embeddingStackRow, onRefreshHub, refresh, setActionNotice]);

  const embeddingProbeIds = useMemo(
    () =>
      embeddingStackRow
        ? embeddingModelIdsFromExternalRow(embeddingStackRow)
        : [],
    [embeddingStackRow],
  );

  const externalEmbeddingInUse = useMemo(() => {
    if (externalLlmFocus === null || externalLlmFocus === "milady-gguf")
      return null;
    if (!embeddingStackRow) {
      return {
        primary: "No qualifying local HTTP stack",
        detail:
          "Set probe URLs on Local AI cards and refresh until one stack is reachable with models.",
      };
    }
    const ids = embeddingProbeIds;
    const cfgModel = openAiEmbeddingModel.trim();
    if (cfgModel && ids.includes(cfgModel)) {
      return {
        primary: cfgModel,
        detail: `OpenAI-compatible embeddings via ${embeddingStackRow.displayName} (${embeddingStackRow.endpoint}).`,
      };
    }
    if (ids.length === 1) {
      const [onlyId] = ids;
      return {
        primary: onlyId ?? "",
        detail: `Only embedding-shaped id from ${embeddingStackRow.displayName}. Save it below as OPENAI_EMBEDDING_MODEL so the plugin uses this id.`,
      };
    }
    if (ids.length === 0) {
      const probeCount =
        probeModelIdsForEmbeddingListing(embeddingStackRow).length;
      return {
        primary: "No embedding-shaped ids in probe list",
        detail: `${embeddingStackRow.displayName} returned ${probeCount} model id(s); none matched embedding heuristics. Try a model name containing “embed”, “bge-”, etc.`,
      };
    }
    return {
      primary: cfgModel || "Not set in agent config",
      detail: `${ids.length} embedding-shaped ids from ${embeddingStackRow.displayName} — pick one below.`,
    };
  }, [
    externalLlmFocus,
    embeddingStackRow,
    embeddingProbeIds,
    openAiEmbeddingModel,
  ]);

  if (externalLlmFocus === null) {
    if (error) {
      return (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      );
    }
    return null;
  }

  const isMiladyGguf = externalLlmFocus === "milady-gguf";

  if (!isMiladyGguf) {
    const prefLabel =
      externalLlmFocus === "any" ? "Automatic" : externalLlmFocus;
    return (
      <TooltipProvider delayDuration={200}>
        <section className="flex flex-col gap-3">
          <header className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Local embeddings
              </h3>
              <InferenceHelpHint aria-label="External stack embeddings">
                <p>
                  {t("embeddingGeneration.localEmbeddingOpenAiHelpP1", {
                    host: ELIZA_CLOUD_PUBLIC_HOST,
                    defaultValue: `With chat on a remote provider (e.g. ${ELIZA_CLOUD_PUBLIC_HOST}), local TEXT_EMBEDDING can use your OpenAI-compatible local AI engine via OPENAI_BASE_URL / OPENAI_EMBEDDING_MODEL.`,
                  })}
                </p>
                <p>
                  {t("embeddingGeneration.localEmbeddingOpenAiHelpP2", {
                    focus: prefLabel,
                    defaultValue: `The model list below comes from the Local AI probe whose URL matches OPENAI_BASE_URL (same host:port). Engine preference ${prefLabel} only applies when that URL is not set.`,
                  })}
                </p>
              </InferenceHelpHint>
            </div>
          </header>

          {!openAiBaseUrl.trim() ? (
            <p className="text-xs text-amber-800 dark:text-amber-300 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 leading-snug">
              {t("embeddingGeneration.localEmbeddingOpenAiBaseUrlHint", {
                defaultValue:
                  "Set OPENAI_BASE_URL in agent config to your OpenAI-compatible server (include …/v1). The embedding id list follows that host; if it is unset, the list follows Local AI engine preference and may show another engine.",
              })}
            </p>
          ) : null}

          {error && (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          <div className="rounded-xl border border-border bg-card p-3 flex flex-col gap-3">
            {externalEmbeddingInUse ? (
              <div className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2.5 space-y-1">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  In use
                </div>
                <div className="text-sm font-medium text-foreground font-mono leading-snug break-all">
                  {externalEmbeddingInUse.primary}
                </div>
                {externalEmbeddingInUse.detail ? (
                  <div className="text-xs text-muted-foreground leading-snug">
                    {externalEmbeddingInUse.detail}
                  </div>
                ) : null}
              </div>
            ) : null}

            {embeddingStackRow ? (
              <div className="text-xs text-muted-foreground space-y-1">
                <div>
                  <span className="font-medium text-foreground">Stack: </span>
                  {embeddingStackRow.displayName}
                  {embeddingStackRow.reachable ? "" : " · not reachable"}
                </div>
                <div className="font-mono text-[11px] break-all">
                  {embeddingStackRow.endpoint}
                </div>
              </div>
            ) : null}

            {embeddingStackRow ? (
              <>
                {embeddingStackRow.id === "ollama" &&
                embeddingStackRow.reachable &&
                embeddingProbeIds.length === 0 ? (
                  <OllamaEmbeddingPullOffer
                    displayName={embeddingStackRow.displayName}
                    endpoint={embeddingStackRow.endpoint}
                    onPull={handleOllamaPullSuggestedEmbedding}
                    busy={ollamaPullBusy}
                    progress={ollamaPullProgress}
                  />
                ) : null}
                <ExternalEmbeddingOpenAiField
                  stackRow={embeddingStackRow}
                  candidateModelIds={embeddingProbeIds}
                  configuredModel={openAiEmbeddingModel}
                  onAfterSave={() => void refresh()}
                />
              </>
            ) : null}
          </div>
        </section>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <section className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Local embeddings
            </h3>
            <InferenceHelpHint aria-label="About local embeddings">
              <p>
                While chat uses a remote provider (for example{" "}
                {ELIZA_CLOUD_PUBLIC_HOST}), you can still run{" "}
                <span className="font-mono text-[11px]">TEXT_EMBEDDING</span> on
                this device with a small curated GGUF on CPU. That reduces
                embedding API spend and keeps vector writes local.
              </p>
              <p>
                Use the download card when offered, then pick a model from the
                same curated embedding list below. Routing uses hub defaults
                unless you override embedding provider under Local models.
              </p>
            </InferenceHelpHint>
          </div>
          <p className="text-xs text-muted-foreground max-w-prose">
            With Eliza Cloud for chat, you can still run{" "}
            <span className="font-mono text-[11px]">TEXT_EMBEDDING</span> on
            this machine (small GGUF on CPU) to cut embedding spend and keep
            memory vectors off third-party APIs. Download a curated embedding
            GGUF when offered, then pin one of those models to the slot.
          </p>
        </header>

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        {!hub && (
          <p className="text-xs text-muted-foreground">
            Loading model hub for downloads…
          </p>
        )}

        {hub ? (
          <EmbeddingGgufOffer
            catalog={hub.catalog}
            installed={hub.installed.filter(
              (m) => m.source === "milady-download",
            )}
            hardware={hub.hardware}
            downloads={hub.downloads}
            onDownload={handleEmbeddingDownload}
            onCancel={handleEmbeddingCancel}
            busy={hubBusy || downloadBusy}
          />
        ) : null}

        <div className="rounded-xl border border-border bg-card p-3 flex flex-col gap-3">
          {embeddingInUseMilady ? (
            <div className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2.5 space-y-1">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                In use
              </div>
              <div className="text-sm font-medium text-foreground leading-snug">
                {embeddingInUseMilady.primaryLabel}
              </div>
              {embeddingInUseMilady.detail ? (
                <div className="text-xs text-muted-foreground leading-snug">
                  {embeddingInUseMilady.detail}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-1.5 font-medium text-sm">
              Milady-local embedding model
              <InferenceHelpHint aria-label="Embedding model slot">
                <p>
                  Pins a curated on-disk embedding GGUF to the{" "}
                  <span className="font-mono text-[11px]">TEXT_EMBEDDING</span>{" "}
                  assignment (same ids as the Local AI embedding download list).
                  Leave unset to follow the hub active model when it is an
                  embedding GGUF.
                </p>
                <p>
                  Install models via the card above or from the full Local
                  models hub when your AI source shows that panel.
                </p>
              </InferenceHelpHint>
            </span>
            <p className="text-xs text-muted-foreground">
              Optional pin. Only curated embedding catalog installs are listed.
            </p>
            <EmbeddingCatalogModelField
              catalog={catalog}
              installedChoices={embeddingPickerModels}
              value={selectValue}
              onChange={(id) => void handleAssignment(id)}
              disabled={busyAssignment}
              unsetLabel="— unset (hub default) —"
              emptyMessage={
                <p className="text-xs text-muted-foreground">
                  No curated embedding GGUFs on disk yet. Use the download card
                  above (or switch AI model source to Local models for the full
                  hub), then pick a model here.
                </p>
              }
            />
          </div>
        </div>
      </section>
    </TooltipProvider>
  );
}
