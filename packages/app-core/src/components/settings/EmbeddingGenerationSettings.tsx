/**
 * Own-key embedding env vars, compat model catalogs, and Eliza Cloud embedding strip.
 *
 * WHY next to **AI Model**: users tune `OPENAI_EMBEDDING_*` / OpenRouter / Google paths in the same
 * mental session as provider keys. Draft state + `updateConfig` calls can race **`loadPlugins`** and
 * provider switch the same way as `ProviderSwitcher` — when the provider row is “locked”, avoid
 * stacking persists on the same pipeline (see `ProviderSwitcher.tsx` file header: skip competing
 * `updateConfig` while locked; keep local draft vs server truth explicit).
 */
import { VECTOR_DIMS } from "@elizaos/core";
import { ELIZA_CLOUD_PUBLIC_HOST } from "@elizaos/shared/eliza-cloud-presets";
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
  SettingsControls,
  Spinner,
} from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api";
import { useApp } from "../../state";
import { CloudConnectionStatus } from "../cloud/CloudSourceControls";
import { LocalEmbeddingCloudStrip } from "../local-inference/LocalEmbeddingCloudStrip";
import { useLocalInferenceHub } from "../local-inference/local-inference-hub-context";
import {
  ELIZA_CLOUD_EMBEDDING_DEFAULT_MODEL,
  ELIZA_CLOUD_EMBEDDING_PRESETS,
  guessDimensionsForEmbeddingModelId,
  presetForElizaCloudEmbeddingModel,
  readElizaCloudEmbeddingFromConfig,
} from "./eliza-cloud-embedding-presets";
import {
  defForEmbeddingOwnKeyProvider,
  EMBEDDING_OWN_KEY_PROVIDER_DEFS,
  type EmbeddingOwnKeyProviderId,
  OPENROUTER_EMBEDDING_OWN_KEY_DEF,
  usesOpenAiCompatibleEmbeddingPath,
} from "./embedding-own-key-providers";

type CompatEmbeddingCatalogKey = "groq" | "mistral" | "together";

const CLOUD_EMBEDDING_DIM_CHOICES = (
  [...new Set(Object.values(VECTOR_DIMS))] as number[]
).sort((a, b) => a - b);

const SEGMENTED_BUTTON_BASE =
  "flex-1 basis-[calc(50%-0.125rem)] sm:basis-0 min-h-touch rounded-lg border px-2 py-1.5 text-xs-tight font-semibold !whitespace-normal";
const SEGMENTED_BUTTON_ACTIVE =
  "border-accent/45 bg-accent/16 text-txt-strong shadow-sm";
const SEGMENTED_BUTTON_INACTIVE =
  "border-border/40 text-muted-strong hover:border-border-strong hover:bg-bg-hover hover:text-txt";

function segmentedButtonClass(active: boolean): string {
  return `${SEGMENTED_BUTTON_BASE} ${active ? SEGMENTED_BUTTON_ACTIVE : SEGMENTED_BUTTON_INACTIVE}`;
}

function isLikelyEmbeddingModelId(id: string): boolean {
  const s = id.toLowerCase();
  return (
    s.includes("embed") ||
    s.includes("text-embedding") ||
    s.includes("nomic") ||
    s.includes("multilingual-e5") ||
    s.includes("/e5-") ||
    s.includes("mistral-embed")
  );
}

function embeddingCatalogFromModelsResponse(res: unknown): Array<{
  id: string;
  name?: string;
  category?: string;
}> {
  const r = res as {
    models?: Array<{ id?: unknown; name?: unknown; category?: unknown }>;
  };
  const raw = Array.isArray(r?.models) ? r.models : [];
  return raw
    .map((m) => {
      const id = typeof m?.id === "string" ? m.id.trim() : "";
      if (!id) return null;
      const name = typeof m?.name === "string" ? m.name.trim() : undefined;
      const category = typeof m?.category === "string" ? m.category : undefined;
      return { id, name, category };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .filter(
      (m) => m.category === "embedding" || isLikelyEmbeddingModelId(m.id),
    );
}

export type EmbeddingApiSource = "elizacloud" | "local" | "own-key" | "off";

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

export function readEmbeddingSource(
  ui: Record<string, unknown> | undefined,
): EmbeddingApiSource {
  const raw = ui?.embeddingApiSource;
  if (
    raw === "local" ||
    raw === "own-key" ||
    raw === "elizacloud" ||
    raw === "off"
  ) {
    return raw;
  }
  const legacy = ui?.useLocalEmbeddingWithCloud;
  if (legacy === true || legacy === "1" || legacy === 1) return "local";
  return "elizacloud";
}

const EMBEDDING_OWN_KEY_PROVIDER_IDS = new Set<EmbeddingOwnKeyProviderId>([
  "google",
  "groq",
  "mistral",
  "openai",
  "openrouter",
  "together",
]);

function readOwnKeyProvider(
  ui: Record<string, unknown> | undefined,
  envVars: Record<string, string>,
): EmbeddingOwnKeyProviderId {
  const raw = ui?.embeddingOwnKeyProvider;
  if (
    typeof raw === "string" &&
    EMBEDDING_OWN_KEY_PROVIDER_IDS.has(raw as EmbeddingOwnKeyProviderId)
  ) {
    return raw as EmbeddingOwnKeyProviderId;
  }
  const url = (envVars.OPENAI_EMBEDDING_URL ?? "").toLowerCase();
  if (url.includes("api.groq.com")) return "groq";
  if (url.includes("api.mistral.ai")) return "mistral";
  if (url.includes("api.together.xyz")) return "together";
  return "openai";
}

/**
 * Embeddings “API source” — mirrors the Media **Generation** pattern (Eliza
 * Cloud vs local vs own keys vs off). Local stack probes live in the shared
 * strip between AI Models and this section.
 */
export function EmbeddingGenerationSettings({
  onEmbeddingApiSourceChange,
}: {
  onEmbeddingApiSourceChange?: (source: EmbeddingApiSource) => void;
} = {}) {
  const { t, elizaCloudConnected, setActionNotice } = useApp();
  const { hub, busy, refresh, routingRefreshSignal } = useLocalInferenceHub();
  const [loading, setLoading] = useState(true);
  const [busySource, setBusySource] = useState(false);
  const [source, setSource] = useState<EmbeddingApiSource>("elizacloud");
  const [ownKeyProvider, setOwnKeyProvider] =
    useState<EmbeddingOwnKeyProviderId>("openai");
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [elizaCloudEmbedModel, setElizaCloudEmbedModel] = useState(
    ELIZA_CLOUD_EMBEDDING_DEFAULT_MODEL,
  );
  const [elizaCloudEmbedDims, setElizaCloudEmbedDims] = useState("1536");
  const [cloudEmbedBusy, setCloudEmbedBusy] = useState(false);
  const [cloudEmbedCatalog, setCloudEmbedCatalog] = useState<
    Array<{ id: string; name?: string; category?: string }>
  >([]);
  const [cloudEmbedCatalogLoading, setCloudEmbedCatalogLoading] =
    useState(false);
  const [cloudEmbedCatalogError, setCloudEmbedCatalogError] = useState<
    string | null
  >(null);
  const [openrouterEmbedCatalog, setOpenrouterEmbedCatalog] = useState<
    Array<{ id: string; name?: string; category?: string }>
  >([]);
  const [openrouterEmbedCatalogLoading, setOpenrouterEmbedCatalogLoading] =
    useState(false);
  const [openrouterEmbedCatalogError, setOpenrouterEmbedCatalogError] =
    useState<string | null>(null);
  const [compatEmbedByProvider, setCompatEmbedByProvider] = useState<
    Partial<
      Record<
        CompatEmbeddingCatalogKey,
        Array<{ id: string; name?: string; category?: string }>
      >
    >
  >({});
  const [compatEmbedCatalogLoading, setCompatEmbedCatalogLoading] =
    useState<CompatEmbeddingCatalogKey | null>(null);
  const [compatEmbedCatalogError, setCompatEmbedCatalogError] = useState<
    Partial<Record<CompatEmbeddingCatalogKey, string | null>>
  >({});

  const refreshFromConfig = useCallback(async () => {
    try {
      const cfg = (await client.getConfig()) as Record<string, unknown>;
      const ui = cfg.ui as Record<string, unknown> | undefined;
      let next = readEmbeddingSource(ui);
      if (next === "elizacloud" && !elizaCloudConnected) {
        next = "own-key";
        await client.updateConfig({
          ui: {
            embeddingApiSource: next,
            useLocalEmbeddingWithCloud: false,
          },
        });
      }
      setSource(next);
      onEmbeddingApiSourceChange?.(next);
      const vars = readEnvVarsFromConfig(cfg);
      setOwnKeyProvider(readOwnKeyProvider(ui, vars));
      const drafts: Record<string, string> = {};
      for (const def of EMBEDDING_OWN_KEY_PROVIDER_DEFS) {
        drafts[def.modelEnvVar] = vars[def.modelEnvVar]?.trim() ?? "";
        if (def.dimensionsEnvVar) {
          drafts[def.dimensionsEnvVar] =
            vars[def.dimensionsEnvVar]?.trim() ?? def.defaultDimensions ?? "";
        }
      }
      drafts.OPENAI_EMBEDDING_URL = vars.OPENAI_EMBEDDING_URL?.trim() ?? "";
      setModelDrafts(drafts);
      const cloudEmb = readElizaCloudEmbeddingFromConfig(cfg);
      const dParsed = Number.parseInt(cloudEmb.dimensions, 10);
      const dimsOk =
        Number.isFinite(dParsed) &&
        CLOUD_EMBEDDING_DIM_CHOICES.includes(dParsed);
      setElizaCloudEmbedModel(cloudEmb.model);
      setElizaCloudEmbedDims(
        dimsOk
          ? cloudEmb.dimensions
          : (presetForElizaCloudEmbeddingModel(cloudEmb.model)?.dimensions ??
              "1536"),
      );
    } catch {
      setActionNotice?.(
        t("embeddingGeneration.loadFailed", {
          defaultValue: "Failed to load embedding settings",
        }),
        "error",
        4000,
      );
    } finally {
      setLoading(false);
    }
  }, [elizaCloudConnected, onEmbeddingApiSourceChange, setActionNotice, t]);

  useEffect(() => {
    void refreshFromConfig();
  }, [refreshFromConfig]);

  const loadCloudEmbeddingCatalog = useCallback(
    async (force: boolean) => {
      if (!elizaCloudConnected) return;
      setCloudEmbedCatalogLoading(true);
      setCloudEmbedCatalogError(null);
      try {
        const res = await client.fetchModels("elizacloud", force);
        setCloudEmbedCatalog(embeddingCatalogFromModelsResponse(res));
      } catch (e) {
        setCloudEmbedCatalog([]);
        setCloudEmbedCatalogError(e instanceof Error ? e.message : String(e));
      } finally {
        setCloudEmbedCatalogLoading(false);
      }
    },
    [elizaCloudConnected],
  );

  useEffect(() => {
    if (source !== "elizacloud" || !elizaCloudConnected) return;
    void loadCloudEmbeddingCatalog(false);
  }, [elizaCloudConnected, loadCloudEmbeddingCatalog, source]);

  const loadOpenrouterEmbeddingCatalog = useCallback(async (force: boolean) => {
    setOpenrouterEmbedCatalogLoading(true);
    setOpenrouterEmbedCatalogError(null);
    try {
      const res = await client.fetchModels("openrouter", force);
      setOpenrouterEmbedCatalog(embeddingCatalogFromModelsResponse(res));
    } catch (e) {
      setOpenrouterEmbedCatalog([]);
      setOpenrouterEmbedCatalogError(
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setOpenrouterEmbedCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (source !== "own-key" || ownKeyProvider !== "openrouter") return;
    void loadOpenrouterEmbeddingCatalog(false);
  }, [loadOpenrouterEmbeddingCatalog, ownKeyProvider, source]);

  const loadCompatEmbeddingCatalog = useCallback(
    async (providerId: CompatEmbeddingCatalogKey, force: boolean) => {
      setCompatEmbedCatalogLoading(providerId);
      setCompatEmbedCatalogError((prev) => ({ ...prev, [providerId]: null }));
      try {
        const res = await client.fetchModels(providerId, force);
        const rows = embeddingCatalogFromModelsResponse(res);
        setCompatEmbedByProvider((prev) => ({ ...prev, [providerId]: rows }));
      } catch (e) {
        setCompatEmbedByProvider((prev) => ({ ...prev, [providerId]: [] }));
        setCompatEmbedCatalogError((prev) => ({
          ...prev,
          [providerId]: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        setCompatEmbedCatalogLoading(null);
      }
    },
    [],
  );

  useEffect(() => {
    if (source !== "own-key") return;
    const def = defForEmbeddingOwnKeyProvider(ownKeyProvider);
    const pid = def?.modelsCatalogProviderId;
    if (!pid) return;
    void loadCompatEmbeddingCatalog(pid, false);
  }, [loadCompatEmbeddingCatalog, ownKeyProvider, source]);

  const handleSourceChange = useCallback(
    async (next: EmbeddingApiSource) => {
      if (next === source || busySource) return;
      if (next === "elizacloud" && !elizaCloudConnected) return;
      setBusySource(true);
      try {
        await client.updateConfig({
          ui: {
            embeddingApiSource: next,
            useLocalEmbeddingWithCloud: next === "local",
          },
        });
        setSource(next);
        onEmbeddingApiSourceChange?.(next);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionNotice?.(
          t("embeddingGeneration.saveFailed", {
            defaultValue: `Could not save: ${msg}`,
          }),
          "error",
          5000,
        );
      } finally {
        setBusySource(false);
      }
    },
    [
      busySource,
      elizaCloudConnected,
      onEmbeddingApiSourceChange,
      setActionNotice,
      source,
      t,
    ],
  );

  const handleOwnKeyProviderChange = useCallback(
    async (next: EmbeddingOwnKeyProviderId) => {
      if (next === ownKeyProvider) return;
      const prevDef = defForEmbeddingOwnKeyProvider(ownKeyProvider);
      const nextDef = defForEmbeddingOwnKeyProvider(next);
      const envVars: Record<string, string> = {};

      if (nextDef?.openAiEmbeddingBaseUrl) {
        envVars.OPENAI_EMBEDDING_URL = nextDef.openAiEmbeddingBaseUrl;
        const baseChanged =
          (prevDef?.openAiEmbeddingBaseUrl ?? "") !==
          (nextDef.openAiEmbeddingBaseUrl ?? "");
        const resetModel =
          baseChanged ||
          prevDef?.id === "google" ||
          prevDef?.id === "openrouter";
        if (resetModel) {
          envVars.OPENAI_EMBEDDING_MODEL = nextDef.placeholder;
          const dk = nextDef.dimensionsEnvVar;
          if (dk) {
            envVars[dk] =
              nextDef.defaultDimensions ??
              guessDimensionsForEmbeddingModelId(nextDef.placeholder);
          }
        } else {
          const cur =
            modelDrafts.OPENAI_EMBEDDING_MODEL?.trim() || nextDef.placeholder;
          envVars.OPENAI_EMBEDDING_MODEL = cur;
          const dk = nextDef.dimensionsEnvVar;
          if (dk) {
            const existing = modelDrafts[dk]?.trim();
            envVars[dk] =
              existing ||
              nextDef.defaultDimensions ||
              guessDimensionsForEmbeddingModelId(cur);
          }
        }
      } else if (prevDef?.openAiEmbeddingBaseUrl) {
        envVars.OPENAI_EMBEDDING_URL = "";
        if (next === "openai") {
          envVars.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
          envVars.OPENAI_EMBEDDING_DIMENSIONS = "1536";
        }
      }

      try {
        await client.updateConfig({
          ui: { embeddingOwnKeyProvider: next },
          ...(Object.keys(envVars).length > 0
            ? { env: { vars: envVars } }
            : {}),
        });
        setOwnKeyProvider(next);
        if (Object.keys(envVars).length > 0) {
          setModelDrafts((p) => ({ ...p, ...envVars }));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionNotice?.(
          t("embeddingGeneration.saveFailed", {
            defaultValue: `Could not save: ${msg}`,
          }),
          "error",
          5000,
        );
      }
    },
    [modelDrafts, ownKeyProvider, setActionNotice, t],
  );

  const persistElizaCloudEmbedding = useCallback(
    async (model: string, dimensions: string) => {
      const m = (model.trim() || ELIZA_CLOUD_EMBEDDING_DEFAULT_MODEL).trim();
      const preset = presetForElizaCloudEmbeddingModel(m);
      const d = (preset?.dimensions ?? (dimensions.trim() || "1536")).trim();
      setCloudEmbedBusy(true);
      try {
        await client.updateConfig({
          env: {
            vars: {
              ELIZAOS_CLOUD_EMBEDDING_MODEL: m,
              ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS: d,
            },
          },
        });
        setElizaCloudEmbedModel(m);
        setElizaCloudEmbedDims(d);
        setActionNotice?.(
          t("embeddingGeneration.embeddingModelSaved", {
            defaultValue: "Embedding model saved",
          }),
          "success",
          2500,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionNotice?.(
          t("embeddingGeneration.saveFailed", {
            defaultValue: `Could not save: ${msg}`,
          }),
          "error",
          5000,
        );
      } finally {
        setCloudEmbedBusy(false);
      }
    },
    [setActionNotice, t],
  );

  const persistModelEnv = useCallback(
    async (envVar: string, value: string) => {
      const trimmed = value.trim();
      try {
        await client.updateConfig({
          env: { vars: { [envVar]: trimmed } },
        });
        setModelDrafts((prev) => ({ ...prev, [envVar]: trimmed }));
        setActionNotice?.(
          t("embeddingGeneration.embeddingModelSaved", {
            defaultValue: "Embedding model saved",
          }),
          "success",
          2500,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionNotice?.(
          t("embeddingGeneration.saveFailed", {
            defaultValue: `Could not save: ${msg}`,
          }),
          "error",
          5000,
        );
      }
    },
    [setActionNotice, t],
  );

  const persistOpenrouterEmbeddingModel = useCallback(
    async (modelId: string) => {
      const def = OPENROUTER_EMBEDDING_OWN_KEY_DEF;
      const dimKey = def.dimensionsEnvVar;
      if (!dimKey) return;
      const trimmed = modelId.trim();
      if (!trimmed) return;
      const dims = guessDimensionsForEmbeddingModelId(trimmed);
      try {
        await client.updateConfig({
          env: {
            vars: {
              [def.modelEnvVar]: trimmed,
              [dimKey]: dims,
            },
          },
        });
        setModelDrafts((prev) => ({
          ...prev,
          [def.modelEnvVar]: trimmed,
          [dimKey]: dims,
        }));
        setActionNotice?.(
          t("embeddingGeneration.embeddingModelSaved", {
            defaultValue: "Embedding model saved",
          }),
          "success",
          2500,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionNotice?.(
          t("embeddingGeneration.saveFailed", {
            defaultValue: `Could not save: ${msg}`,
          }),
          "error",
          5000,
        );
      }
    },
    [setActionNotice, t],
  );

  const persistOpenAiCompatEmbeddingModel = useCallback(
    async (
      def: NonNullable<ReturnType<typeof defForEmbeddingOwnKeyProvider>>,
      modelId: string,
    ) => {
      const openAiEmbeddingBaseUrl = def.openAiEmbeddingBaseUrl;
      const dimKey = def.dimensionsEnvVar;
      if (!openAiEmbeddingBaseUrl || !dimKey) return;
      const trimmed = modelId.trim();
      if (!trimmed) return;
      const dims = guessDimensionsForEmbeddingModelId(trimmed);
      try {
        await client.updateConfig({
          env: {
            vars: {
              OPENAI_EMBEDDING_URL: openAiEmbeddingBaseUrl,
              [def.modelEnvVar]: trimmed,
              [dimKey]: dims,
            },
          },
        });
        setModelDrafts((prev) => {
          const next: Record<string, string> = { ...prev };
          next.OPENAI_EMBEDDING_URL = openAiEmbeddingBaseUrl;
          next[def.modelEnvVar] = trimmed;
          next[dimKey] = dims;
          return next;
        });
        setActionNotice?.(
          t("embeddingGeneration.embeddingModelSaved", {
            defaultValue: "Embedding model saved",
          }),
          "success",
          2500,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionNotice?.(
          t("embeddingGeneration.saveFailed", {
            defaultValue: `Could not save: ${msg}`,
          }),
          "error",
          5000,
        );
      }
    },
    [setActionNotice, t],
  );

  const selectedOwnKeyDef = useMemo(
    () => defForEmbeddingOwnKeyProvider(ownKeyProvider),
    [ownKeyProvider],
  );

  const elizaCloudEmbedDimsSelectValue = useMemo(() => {
    const n = Number.parseInt(elizaCloudEmbedDims, 10);
    return CLOUD_EMBEDDING_DIM_CHOICES.includes(n) ? String(n) : "1536";
  }, [elizaCloudEmbedDims]);

  const cloudEmbedModelOptions = useMemo(() => {
    const byId = new Map<string, { id: string; label: string }>();
    for (const p of ELIZA_CLOUD_EMBEDDING_PRESETS) {
      byId.set(p.id, { id: p.id, label: t(p.labelKey) });
    }
    for (const row of cloudEmbedCatalog) {
      const id = row.id.trim();
      if (!id || byId.has(id)) continue;
      byId.set(id, { id, label: row.name?.trim() || id });
    }
    const cur = elizaCloudEmbedModel.trim();
    if (cur && !byId.has(cur)) {
      byId.set(cur, { id: cur, label: cur });
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [cloudEmbedCatalog, elizaCloudEmbedModel, t]);

  const cloudEmbedModelSelectValue = useMemo(() => {
    const ids = new Set(cloudEmbedModelOptions.map((o) => o.id));
    return ids.has(elizaCloudEmbedModel)
      ? elizaCloudEmbedModel
      : ELIZA_CLOUD_EMBEDDING_DEFAULT_MODEL;
  }, [cloudEmbedModelOptions, elizaCloudEmbedModel]);

  const openrouterEmbedModelOptions = useMemo(() => {
    const byId = new Map<string, { id: string; label: string }>();
    const boot = OPENROUTER_EMBEDDING_OWN_KEY_DEF.placeholder;
    byId.set(boot, {
      id: boot,
      label: t("embeddingGeneration.openrouterEmbeddingDefaultPick", {
        defaultValue: "Suggested default",
      }),
    });
    for (const row of openrouterEmbedCatalog) {
      const id = row.id.trim();
      if (!id || byId.has(id)) continue;
      byId.set(id, { id, label: row.name?.trim() || id });
    }
    const cur = (
      modelDrafts[OPENROUTER_EMBEDDING_OWN_KEY_DEF.modelEnvVar] ?? ""
    ).trim();
    if (cur && !byId.has(cur)) {
      byId.set(cur, { id: cur, label: cur });
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [modelDrafts, openrouterEmbedCatalog, t]);

  const openrouterEmbedModelSelectValue = useMemo(() => {
    const ids = new Set(openrouterEmbedModelOptions.map((o) => o.id));
    const cur = (
      modelDrafts[OPENROUTER_EMBEDDING_OWN_KEY_DEF.modelEnvVar] ?? ""
    ).trim();
    if (cur && ids.has(cur)) return cur;
    return OPENROUTER_EMBEDDING_OWN_KEY_DEF.placeholder;
  }, [modelDrafts, openrouterEmbedModelOptions]);

  const openrouterEmbedDimsSelectValue = useMemo(() => {
    const dimKey = OPENROUTER_EMBEDDING_OWN_KEY_DEF.dimensionsEnvVar;
    const raw = dimKey ? (modelDrafts[dimKey] ?? "") : "";
    const n = Number.parseInt(raw, 10);
    return CLOUD_EMBEDDING_DIM_CHOICES.includes(n) ? String(n) : "1536";
  }, [modelDrafts]);

  const compatEmbedCatalogRows = useMemo(() => {
    const pid = selectedOwnKeyDef?.modelsCatalogProviderId;
    return pid ? (compatEmbedByProvider[pid] ?? []) : [];
  }, [compatEmbedByProvider, selectedOwnKeyDef?.modelsCatalogProviderId]);

  const compatEmbedModelOptions = useMemo(() => {
    const def = selectedOwnKeyDef;
    if (!def?.openAiEmbeddingBaseUrl) return [];
    const byId = new Map<string, { id: string; label: string }>();
    byId.set(def.placeholder, {
      id: def.placeholder,
      label: t("embeddingGeneration.openrouterEmbeddingDefaultPick", {
        defaultValue: "Suggested default",
      }),
    });
    for (const row of compatEmbedCatalogRows) {
      const id = row.id.trim();
      if (!id || byId.has(id)) continue;
      byId.set(id, { id, label: row.name?.trim() || id });
    }
    const cur = (modelDrafts[def.modelEnvVar] ?? "").trim();
    if (cur && !byId.has(cur)) {
      byId.set(cur, { id: cur, label: cur });
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [compatEmbedCatalogRows, modelDrafts, selectedOwnKeyDef, t]);

  const compatEmbedModelSelectValue = useMemo(() => {
    const def = selectedOwnKeyDef;
    if (!def?.openAiEmbeddingBaseUrl) return "";
    const ids = new Set(compatEmbedModelOptions.map((o) => o.id));
    const cur = (modelDrafts[def.modelEnvVar] ?? "").trim();
    if (cur && ids.has(cur)) return cur;
    return def.placeholder;
  }, [compatEmbedModelOptions, modelDrafts, selectedOwnKeyDef]);

  const compatEmbedDimsSelectValue = useMemo(() => {
    const dimKey = selectedOwnKeyDef?.dimensionsEnvVar;
    if (!dimKey) return "1536";
    const raw = modelDrafts[dimKey] ?? "";
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && CLOUD_EMBEDDING_DIM_CHOICES.includes(n)) {
      return String(n);
    }
    const fb = Number.parseInt(
      selectedOwnKeyDef?.defaultDimensions ?? "1536",
      10,
    );
    return CLOUD_EMBEDDING_DIM_CHOICES.includes(fb) ? String(fb) : "1536";
  }, [modelDrafts, selectedOwnKeyDef]);

  const compatEmbedCatalogErr = useMemo(() => {
    const pid = selectedOwnKeyDef?.modelsCatalogProviderId;
    return pid ? (compatEmbedCatalogError[pid] ?? null) : null;
  }, [compatEmbedCatalogError, selectedOwnKeyDef]);

  const configured = useMemo(() => {
    if (source === "off") return true;
    if (source === "elizacloud") return elizaCloudConnected;
    if (source === "local") return true;
    if (source === "own-key") {
      const def = defForEmbeddingOwnKeyProvider(ownKeyProvider);
      if (!def) return false;
      if (!(modelDrafts[def.modelEnvVar] ?? "").trim()) return false;
      if (def.dimensionsEnvVar) {
        const d = Number.parseInt(modelDrafts[def.dimensionsEnvVar] ?? "", 10);
        return Number.isFinite(d) && CLOUD_EMBEDDING_DIM_CHOICES.includes(d);
      }
      return true;
    }
    return false;
  }, [elizaCloudConnected, modelDrafts, ownKeyProvider, source]);

  const sourceButtons = useMemo(() => {
    const rows: Array<{ id: EmbeddingApiSource; label: string }> = [];
    rows.push({
      id: "off",
      label: t("embeddingGeneration.sourceOff", {
        defaultValue: "Off",
      }),
    });
    rows.push({
      id: "local",
      label: t("embeddingGeneration.sourceLocal", {
        defaultValue: "Local",
      }),
    });
    if (elizaCloudConnected) {
      rows.push({
        id: "elizacloud",
        label: t("settings.sections.cloud.label", {
          defaultValue: "ElizaCloud.ai",
        }),
      });
    }
    rows.push({
      id: "own-key",
      label: t("embeddingGeneration.sourceOwnKey", {
        defaultValue: "Own API key",
      }),
    });
    return rows;
  }, [elizaCloudConnected, t]);

  if (loading) {
    return (
      <div className="py-4 text-center text-muted text-xs">
        {t("embeddingGeneration.loading", { defaultValue: "Loading…" })}
      </div>
    );
  }

  return (
    <section
      className="flex flex-col gap-4 rounded-xl border border-border/70 bg-card/85 px-3 py-3 shadow-sm"
      aria-label={t("embeddingGeneration.regionLabel", {
        defaultValue: "Embedding API source",
      })}
    >
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <span className="text-xs font-semibold text-muted w-full sm:w-auto">
          {t("embeddingGeneration.apiSourceLabel", {
            defaultValue: "API source",
          })}
        </span>
        <SettingsControls.SegmentedGroup className="flex-1 min-w-0">
          {sourceButtons.map(({ id, label }) => {
            const active = source === id;
            return (
              <Button
                key={id}
                type="button"
                variant={active ? "default" : "ghost"}
                size="sm"
                className={segmentedButtonClass(active)}
                disabled={busySource}
                aria-pressed={active}
                onClick={() => void handleSourceChange(id)}
              >
                {label}
              </Button>
            );
          })}
        </SettingsControls.SegmentedGroup>
        <span
          className={`ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium ${
            configured
              ? "border-ok/30 bg-ok/10 text-ok"
              : "border-warn/30 bg-warn/10 text-warn"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${configured ? "bg-ok" : "bg-warn"}`}
          />
          {source === "off"
            ? t("embeddingGeneration.statusOff", { defaultValue: "Off" })
            : configured
              ? t("config-field.Configured")
              : t("mediasettingssection.NeedsSetup")}
        </span>
      </div>

      {source === "off" && (
        <p className="text-xs text-muted-foreground leading-snug max-w-prose">
          {t("embeddingGeneration.offCopy", {
            defaultValue:
              "No embedding API is selected. Long-term memory and document recall that rely on vectors may be limited until you turn embeddings back on.",
          })}
        </p>
      )}

      {source === "local" && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground leading-snug max-w-prose">
            {t("embeddingGeneration.localCopyNoStacks", {
              defaultValue:
                "Run TEXT_EMBEDDING on this device (Milady GGUF and/or loopback OpenAI-compatible stacks). Use the Local AI engines section above for probe URLs and engine preference.",
            })}
          </p>
          <LocalEmbeddingCloudStrip
            hub={hub}
            onRefreshHub={() => void refresh()}
            hubBusy={busy}
            routingRefreshSignal={routingRefreshSignal}
          />
        </div>
      )}

      {source === "elizacloud" && (
        <div className="flex flex-col gap-3">
          <CloudConnectionStatus
            connected={elizaCloudConnected}
            disconnectedText={t(
              "elizaclouddashboard.ElizaCloudNotConnectedSettings",
            )}
          />
          <p className="text-xs text-muted-foreground leading-snug max-w-prose">
            {t("embeddingGeneration.elizaCloudCopy", {
              host: ELIZA_CLOUD_PUBLIC_HOST,
              defaultValue: `Vectors use your ${ELIZA_CLOUD_PUBLIC_HOST} subscription when chat is routed there.`,
            })}
          </p>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-muted">
              {t("embeddingGeneration.elizaCloudEmbeddingModelLabel", {
                defaultValue: "Cloud embedding model",
              })}
            </span>
            <div className="grid gap-1.5 grid-cols-1 sm:grid-cols-3">
              {ELIZA_CLOUD_EMBEDDING_PRESETS.map((preset) => {
                const active = elizaCloudEmbedModel === preset.id;
                return (
                  <Button
                    key={preset.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={cloudEmbedBusy}
                    className={`h-auto px-3 py-2 text-xs font-normal rounded-lg border border-border ${
                      active
                        ? "bg-accent/10 border-accent text-txt"
                        : "bg-card text-txt hover:bg-bg-hover"
                    }`}
                    onClick={() =>
                      void persistElizaCloudEmbedding(
                        preset.id,
                        preset.dimensions,
                      )
                    }
                  >
                    <div className="font-semibold text-left w-full">
                      {t(preset.labelKey)}
                    </div>
                    <div className="text-2xs text-muted mt-0.5 font-mono text-left w-full truncate">
                      {preset.id}
                    </div>
                  </Button>
                );
              })}
            </div>
            <p className="text-2xs text-muted-foreground leading-snug max-w-prose">
              {t("embeddingGeneration.elizaCloudEmbeddingPresetsHint", {
                host: ELIZA_CLOUD_PUBLIC_HOST,
                defaultValue:
                  "Defaults to a compact OpenAI-compatible embedding. Use quick picks above or choose any embedding model your gateway lists below.",
              })}
            </p>
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label className="text-xs font-medium text-muted-foreground">
                  {t("embeddingGeneration.elizaCloudEmbeddingCatalogLabel", {
                    defaultValue: "Embedding model",
                  })}
                </Label>
                <div className="flex items-center gap-2">
                  {cloudEmbedCatalogLoading ? (
                    <Spinner size={16} className="text-muted-foreground" />
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 text-2xs"
                    disabled={
                      cloudEmbedBusy ||
                      cloudEmbedCatalogLoading ||
                      !elizaCloudConnected
                    }
                    onClick={() => void loadCloudEmbeddingCatalog(true)}
                  >
                    {t("embeddingGeneration.elizaCloudEmbeddingRefreshList", {
                      defaultValue: "Refresh list",
                    })}
                  </Button>
                </div>
              </div>
              {cloudEmbedCatalogError ? (
                <p className="text-2xs text-warn leading-snug" role="alert">
                  {cloudEmbedCatalogError}
                </p>
              ) : null}
              <Select
                value={cloudEmbedModelSelectValue}
                disabled={
                  cloudEmbedBusy ||
                  cloudEmbedCatalogLoading ||
                  !elizaCloudConnected
                }
                onValueChange={(value: string) => {
                  const preset = presetForElizaCloudEmbeddingModel(value);
                  const dims =
                    preset?.dimensions ??
                    guessDimensionsForEmbeddingModelId(value);
                  void persistElizaCloudEmbedding(value, dims);
                }}
              >
                <SettingsControls.SelectTrigger
                  variant="compact"
                  className="w-full font-mono text-xs"
                >
                  <SelectValue />
                </SettingsControls.SelectTrigger>
                <SelectContent className="max-h-72">
                  {cloudEmbedModelOptions.map((opt) => (
                    <SelectItem key={opt.id} value={opt.id}>
                      <span className="font-mono text-xs">
                        {opt.label !== opt.id
                          ? `${opt.id} — ${opt.label}`
                          : opt.id}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                <span className="text-2xs font-medium text-muted-foreground shrink-0">
                  {t("embeddingGeneration.elizaCloudEmbeddingDimensionsLabel", {
                    defaultValue: "Dimensions",
                  })}
                </span>
                <Select
                  value={elizaCloudEmbedDimsSelectValue}
                  disabled={cloudEmbedBusy}
                  onValueChange={(value: string) => {
                    setElizaCloudEmbedDims(value);
                    void persistElizaCloudEmbedding(
                      elizaCloudEmbedModel,
                      value,
                    );
                  }}
                >
                  <SettingsControls.SelectTrigger
                    variant="compact"
                    className="sm:max-w-[12rem]"
                  >
                    <SelectValue />
                  </SettingsControls.SelectTrigger>
                  <SelectContent>
                    {CLOUD_EMBEDDING_DIM_CHOICES.map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!presetForElizaCloudEmbeddingModel(
                elizaCloudEmbedModel.trim(),
              ) ? (
                <p className="text-2xs text-muted-foreground leading-snug">
                  {t("embeddingGeneration.elizaCloudEmbeddingCustomDimsHint", {
                    defaultValue:
                      "For custom models, set dimensions to match the gateway output or memory indexing may fail.",
                  })}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {source === "own-key" && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground leading-snug max-w-prose">
            {t("embeddingGeneration.ownKeyIntroGrid", {
              defaultValue:
                "Choose a vendor, set its API key under AI Models, then save the embedding model id for that stack.",
            })}
          </p>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-muted">
              {t("mediasettingssection.Provider", {
                defaultValue: "Provider",
              })}
            </span>
            <div className="grid gap-1.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
              {EMBEDDING_OWN_KEY_PROVIDER_DEFS.map((def) => {
                const active = ownKeyProvider === def.id;
                return (
                  <Button
                    key={def.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    className={`h-auto px-3 py-2 text-xs font-normal rounded-lg border border-border ${
                      active
                        ? "bg-accent/10 border-accent text-txt"
                        : "bg-card text-txt hover:bg-bg-hover"
                    }`}
                    onClick={() => void handleOwnKeyProviderChange(def.id)}
                  >
                    <div className="font-semibold">{t(def.labelKey)}</div>
                  </Button>
                );
              })}
            </div>
          </div>

          {selectedOwnKeyDef ? (
            <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5 space-y-2">
              <p className="text-2xs text-muted-foreground leading-snug">
                {selectedOwnKeyDef.id === "openai"
                  ? t("embeddingGeneration.openAiEmbeddingHint", {
                      defaultValue:
                        "Uses OPENAI_API_KEY and OPENAI_BASE_URL from agent config.",
                    })
                  : selectedOwnKeyDef.id === "google"
                    ? t("embeddingGeneration.googleEmbeddingHint", {
                        defaultValue:
                          "Uses GOOGLE_API_KEY / GEMINI_API_KEY from agent config (Google GenAI plugin).",
                      })
                    : selectedOwnKeyDef.id === "openrouter"
                      ? t("embeddingGeneration.openrouterEmbeddingHint", {
                          defaultValue:
                            "Uses OPENROUTER_API_KEY from agent config. Pick an embedding model from OpenRouter’s catalog (same list as /api/models?provider=openrouter).",
                        })
                      : selectedOwnKeyDef.id === "groq"
                        ? t("embeddingGeneration.groqEmbeddingHint", {
                            defaultValue:
                              "Uses @elizaos/plugin-openai against Groq’s OpenAI-compatible /embeddings endpoint. Authentication uses GROQ_API_KEY when OPENAI_EMBEDDING_API_KEY is unset.",
                          })
                        : selectedOwnKeyDef.id === "mistral"
                          ? t("embeddingGeneration.mistralEmbeddingHint", {
                              defaultValue:
                                "Uses @elizaos/plugin-openai against Mistral’s OpenAI-compatible /embeddings endpoint. Authentication uses MISTRAL_API_KEY when OPENAI_EMBEDDING_API_KEY is unset.",
                            })
                          : selectedOwnKeyDef.id === "together"
                            ? t("embeddingGeneration.togetherEmbeddingHint", {
                                defaultValue:
                                  "Uses @elizaos/plugin-openai against Together’s OpenAI-compatible /embeddings endpoint. Authentication uses TOGETHER_API_KEY when OPENAI_EMBEDDING_API_KEY is unset.",
                              })
                            : ""}
              </p>
              {selectedOwnKeyDef.id === "openrouter" ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label className="text-xs font-medium text-muted-foreground">
                      {t("embeddingGeneration.openrouterEmbeddingModelLabel", {
                        defaultValue: "Embedding model",
                      })}
                    </Label>
                    <div className="flex items-center gap-2">
                      {openrouterEmbedCatalogLoading ? (
                        <Spinner size={16} className="text-muted-foreground" />
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-2xs"
                        disabled={openrouterEmbedCatalogLoading}
                        onClick={() =>
                          void loadOpenrouterEmbeddingCatalog(true)
                        }
                      >
                        {t(
                          "embeddingGeneration.elizaCloudEmbeddingRefreshList",
                          {
                            defaultValue: "Refresh list",
                          },
                        )}
                      </Button>
                    </div>
                  </div>
                  {openrouterEmbedCatalogError ? (
                    <p className="text-2xs text-warn leading-snug" role="alert">
                      {openrouterEmbedCatalogError}
                    </p>
                  ) : null}
                  <Select
                    value={openrouterEmbedModelSelectValue}
                    disabled={openrouterEmbedCatalogLoading}
                    onValueChange={(value: string) => {
                      void persistOpenrouterEmbeddingModel(value);
                    }}
                  >
                    <SettingsControls.SelectTrigger
                      variant="compact"
                      className="w-full font-mono text-xs"
                    >
                      <SelectValue />
                    </SettingsControls.SelectTrigger>
                    <SelectContent className="max-h-72">
                      {openrouterEmbedModelOptions.map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>
                          <span className="font-mono text-xs">
                            {opt.label !== opt.id
                              ? `${opt.id} — ${opt.label}`
                              : opt.id}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="text-2xs font-medium text-muted-foreground shrink-0">
                      {t(
                        "embeddingGeneration.elizaCloudEmbeddingDimensionsLabel",
                        {
                          defaultValue: "Dimensions",
                        },
                      )}
                    </span>
                    <Select
                      value={openrouterEmbedDimsSelectValue}
                      disabled={openrouterEmbedCatalogLoading}
                      onValueChange={(value: string) => {
                        const dimKey =
                          OPENROUTER_EMBEDDING_OWN_KEY_DEF.dimensionsEnvVar;
                        if (!dimKey) return;
                        void persistModelEnv(dimKey, value);
                      }}
                    >
                      <SettingsControls.SelectTrigger
                        variant="compact"
                        className="sm:max-w-[12rem]"
                      >
                        <SelectValue />
                      </SettingsControls.SelectTrigger>
                      <SelectContent>
                        {CLOUD_EMBEDDING_DIM_CHOICES.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-2xs text-muted-foreground leading-snug">
                    {t("embeddingGeneration.openrouterEmbeddingDimsHint", {
                      defaultValue:
                        "If vectors from your chosen model use a different size than suggested, adjust dimensions to match or memory indexing may fail.",
                    })}
                  </p>
                </div>
              ) : usesOpenAiCompatibleEmbeddingPath(selectedOwnKeyDef) &&
                selectedOwnKeyDef.modelsCatalogProviderId ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label className="text-xs font-medium text-muted-foreground">
                      {t("embeddingGeneration.openrouterEmbeddingModelLabel", {
                        defaultValue: "Embedding model",
                      })}
                    </Label>
                    <div className="flex items-center gap-2">
                      {compatEmbedCatalogLoading ===
                      selectedOwnKeyDef.modelsCatalogProviderId ? (
                        <Spinner size={16} className="text-muted-foreground" />
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-2xs"
                        disabled={
                          compatEmbedCatalogLoading ===
                          selectedOwnKeyDef.modelsCatalogProviderId
                        }
                        onClick={() => {
                          const pid = selectedOwnKeyDef.modelsCatalogProviderId;
                          if (!pid) return;
                          void loadCompatEmbeddingCatalog(pid, true);
                        }}
                      >
                        {t(
                          "embeddingGeneration.elizaCloudEmbeddingRefreshList",
                          {
                            defaultValue: "Refresh list",
                          },
                        )}
                      </Button>
                    </div>
                  </div>
                  {compatEmbedCatalogErr ? (
                    <p className="text-2xs text-warn leading-snug" role="alert">
                      {compatEmbedCatalogErr}
                    </p>
                  ) : null}
                  <Select
                    value={compatEmbedModelSelectValue}
                    disabled={
                      compatEmbedCatalogLoading ===
                      selectedOwnKeyDef.modelsCatalogProviderId
                    }
                    onValueChange={(value: string) => {
                      void persistOpenAiCompatEmbeddingModel(
                        selectedOwnKeyDef,
                        value,
                      );
                    }}
                  >
                    <SettingsControls.SelectTrigger
                      variant="compact"
                      className="w-full font-mono text-xs"
                    >
                      <SelectValue />
                    </SettingsControls.SelectTrigger>
                    <SelectContent className="max-h-72">
                      {compatEmbedModelOptions.map((opt) => (
                        <SelectItem key={opt.id} value={opt.id}>
                          <span className="font-mono text-xs">
                            {opt.label !== opt.id
                              ? `${opt.id} — ${opt.label}`
                              : opt.id}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="text-2xs font-medium text-muted-foreground shrink-0">
                      {t(
                        "embeddingGeneration.elizaCloudEmbeddingDimensionsLabel",
                        {
                          defaultValue: "Dimensions",
                        },
                      )}
                    </span>
                    <Select
                      value={compatEmbedDimsSelectValue}
                      disabled={
                        compatEmbedCatalogLoading ===
                        selectedOwnKeyDef.modelsCatalogProviderId
                      }
                      onValueChange={(value: string) => {
                        const dimKey = selectedOwnKeyDef.dimensionsEnvVar;
                        if (!dimKey) return;
                        void persistModelEnv(dimKey, value);
                      }}
                    >
                      <SettingsControls.SelectTrigger
                        variant="compact"
                        className="sm:max-w-[12rem]"
                      >
                        <SelectValue />
                      </SettingsControls.SelectTrigger>
                      <SelectContent>
                        {CLOUD_EMBEDDING_DIM_CHOICES.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-2xs text-muted-foreground leading-snug">
                    {t("embeddingGeneration.openrouterEmbeddingDimsHint", {
                      defaultValue:
                        "If vectors from your chosen model use a different size than suggested, adjust dimensions to match or memory indexing may fail.",
                    })}
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    {t("embeddingGeneration.openrouterEmbeddingModelLabel", {
                      defaultValue: "Embedding model",
                    })}
                  </Label>
                  <SettingsControls.Input
                    variant="compact"
                    className="font-mono text-xs"
                    value={modelDrafts[selectedOwnKeyDef.modelEnvVar] ?? ""}
                    placeholder={selectedOwnKeyDef.placeholder}
                    onChange={(e) =>
                      setModelDrafts((prev) => ({
                        ...prev,
                        [selectedOwnKeyDef.modelEnvVar]: e.target.value,
                      }))
                    }
                    onBlur={(e) =>
                      void persistModelEnv(
                        selectedOwnKeyDef.modelEnvVar,
                        e.target.value,
                      )
                    }
                  />
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
