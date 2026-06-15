// odysseus Cookbook (static/js/cookbook.js + cookbookServe.js +
// cookbookDownload.js + cookbook-hwfit.js + cookbook-diagnosis.js, plus the
// .cookbook-* / .hwfit-* / .admin-card rules in static/style.css). odysseus's
// Cookbook is a local-model serve workbench with FOUR tabs — Download / Serve /
// Dependencies / Settings (cookbook.js _renderRecipes, lines 1427-1432). It is
// NOT a recipe/skill grid: the previous port invented a "Recipes / What Fits?"
// surface that does not exist upstream. This rebuild restores the real four-tab
// chrome 1:1.
//
// elizaMapping: eliza DOES have a local-inference backend that maps onto this
// workbench almost field-for-field:
//   • Download tab → client.getLocalInferenceHardware() (the detected-hardware
//     pill row), client.getLocalInferenceCatalog() (the FIT/MODEL/PARAM/QUANT/
//     VRAM/CTX/SCORE scan table — fit is classified client-side from the REAL
//     probe vs the REAL catalog sizeGb/minRamGb, the eliza analogue of
//     odysseus's client-side _detectBackend ranker; no benchmarked t/s exists in
//     eliza's contract so the Speed column honestly shows "—"),
//     client.searchHuggingFaceGguf() (the "Trending models that fit" list +
//     paste-a-HF-link search), and client.startLocalInferenceDownload() (the
//     real Download button).
//   • Serve tab → client.getLocalInferenceInstalled() (cached/installed GGUFs on
//     disk), with the real per-model uninstall available through
//     client.uninstallLocalInferenceModel(). Empty = honest "no cached models".
//   • Dependencies tab → eliza has no /api/cookbook/packages optional-deps
//     surface, so the deps grid renders odysseus's chrome (server select +
//     description) in an honest empty state — never fabricated package rows.
//   • Settings tab → the HF-token block (eliza has no HF-token endpoint, so the
//     input is rendered but disabled with an honest reason) and the Servers
//     block, wired to client.getLocalInferenceProviders() (the real local-
//     inference provider registry). No invented SSH servers.
// Every control either calls a real @elizaos/ui client method or renders a
// faithful inert/disabled state with an honest reason — no fabricated hardware,
// models, packages, or servers.

import type { CatalogModel, HardwareProbe, InstalledModel } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import {
  Box,
  Download,
  Minus,
  RefreshCw,
  Server,
  Settings as SettingsIcon,
  Trash2,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { PREF_KEYS, readPref, writePref } from "./util/storage";

// cookbook.js tab row (lines 1427-1432). data-backend "Search" is the Download
// tab in odysseus's internal naming; we use the visible labels.
type CookbookTab = "download" | "serve" | "dependencies" | "settings";

const COOKBOOK_TABS: ReadonlyArray<{
  id: CookbookTab;
  label: string;
  icon: ReactNode;
}> = [
  { id: "download", label: "Download", icon: <Download size={12} /> },
  { id: "serve", label: "Serve", icon: <Server size={12} /> },
  { id: "dependencies", label: "Dependencies", icon: <Box size={12} /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon size={12} /> },
];

// hwfit toolbar 1: the "Type" use-case select (cookbook.js hwfit-usecase). The
// "Image" option was removed upstream; "Vision" (multimodal) stays.
const USECASE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Type" },
  { value: "general", label: "General" },
  { value: "coding", label: "Coding" },
  { value: "reasoning", label: "Reasoning" },
  { value: "chat", label: "Chat" },
  { value: "multimodal", label: "Vision" },
];

// hwfit-quant select (cookbook.js). Verbatim value/label pairs.
const QUANT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Q4_K_M", label: "Q4" },
  { value: "Q8_0", label: "Q8" },
  { value: "Q6_K", label: "Q6" },
  { value: "Q5_K_M", label: "Q5" },
  { value: "Q3_K_M", label: "Q3" },
  { value: "Q2_K", label: "Q2" },
  { value: "AWQ-4bit", label: "AWQ" },
  { value: "FP8", label: "FP8" },
  { value: "FP4", label: "FP4" },
  { value: "NVFP4", label: "NVFP4" },
  { value: "", label: "Native" },
];

// hwfit-engine select (cookbook.js). llama.cpp/GGUF runs everywhere; vLLM/SGLang
// are CUDA/datacenter-ROCm.
const ENGINE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Engine" },
  { value: "llamacpp", label: "llama.cpp" },
  { value: "vllm", label: "vLLM" },
  { value: "sglang", label: "SGLang" },
];

// hwfit context-length range slider (cookbook-hwfit.js _CTX_PRESETS). The
// slider indexes into these presets; 0 = the model's own max ("Max"). Default
// index is 3 (50k). On change odysseus persists the chosen ctx, forces the sort
// to fit-descending, and re-runs the scan.
const CTX_PRESETS: ReadonlyArray<number> = [
  8192, 16384, 32768, 50000, 131072, 0,
];
const CTX_DEFAULT_INDEX = 3;

// cookbook-hwfit.js _ctxLabel: 0 → "Max"; ≥1000 → "<n>k"; else the raw value.
function ctxLabel(value: number): string {
  if (!value) return "Max";
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

// Serve-tab sort select (cookbook.js serve-sort).
const SERVE_SORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "name", label: "Name" },
  { value: "size-desc", label: "Size ↓" },
  { value: "size-asc", label: "Size ↑" },
  { value: "recent", label: "Recent" },
];

// cookbook-hwfit.js _hwfitColumns — the scan table header. `sortKey` mirrors the
// column's data-sort (null = not sortable). Fit is sortable and ranks the
// categorical fit level; it is the default-active column upstream (the FIT
// header carries the descending triangle in the captured frame).
interface FitColumn {
  sortKey: string | null;
  label: string;
  cls: string;
}

const FIT_COLUMNS: ReadonlyArray<FitColumn> = [
  { sortKey: "fit", label: "Fit", cls: "od-cb-fit-fit" },
  { sortKey: null, label: "Model", cls: "od-cb-fit-name" },
  { sortKey: "params", label: "Param", cls: "od-cb-fit-params" },
  { sortKey: null, label: "Quant", cls: "od-cb-fit-quant" },
  { sortKey: "vram", label: "VRAM", cls: "od-cb-fit-vram" },
  { sortKey: "context", label: "Ctx", cls: "od-cb-fit-ctx" },
  // Speed (t/s) and Score have no eliza benchmark — the columns always render
  // "—" and compareFitRows has no case for them, so the headers are not
  // sortable (sortKey: null, like Model/Quant/Mode).
  { sortKey: null, label: "Speed", cls: "od-cb-fit-speed" },
  { sortKey: null, label: "Score", cls: "od-cb-fit-score" },
  { sortKey: null, label: "Mode", cls: "od-cb-fit-mode" },
];

// cookbook-hwfit.js _fitColors — fit-level → colour. Mapped onto eliza theme
// vars (green/yellow/orange/red) keeping the perfect→too_tight ramp.
const FIT_LEVEL_META: Record<
  HardwareFit,
  { label: string; cls: string; rank: number }
> = {
  fits: { label: "fits", cls: "od-cb-fit-fits", rank: 3 },
  tight: { label: "tight", cls: "od-cb-fit-tight", rank: 1 },
  wontfit: { label: "wont fit", cls: "od-cb-fit-wontfit", rank: 0 },
};

type HardwareFit = "fits" | "tight" | "wontfit";

// Client-side fit classification — the eliza analogue of odysseus's client-side
// ranker. Uses ONLY real probe + real catalog numbers (no fabrication): a model
// "fits" when its download size sits comfortably under available memory, "tight"
// when it crowds it, "wontfit" when RAM is below the catalog's own minimum or
// the file dwarfs memory. Mirrors @elizaos/ui's assessCatalogModelFit thresholds.
function classifyFit(probe: HardwareProbe, model: CatalogModel): HardwareFit {
  const budgetGb = probe.gpu ? probe.gpu.totalVramGb : probe.totalRamGb;
  if (probe.totalRamGb < model.minRamGb) return "wontfit";
  if (model.sizeGb > budgetGb * 0.8) return "wontfit";
  if (model.sizeGb > budgetGb * 0.65) return "tight";
  return "fits";
}

// A scan-table row built from a real catalog model + the real probe. Every field
// is sourced from the backend; `speed`/`score` are null where eliza has no
// measured benchmark, rendered as "—" rather than a fabricated number.
interface FitRow {
  id: string;
  name: string;
  params: string;
  quant: string;
  vramGb: number;
  contextK: number | null;
  mode: string;
  modeTitle: string;
  fit: HardwareFit;
  fitRank: number;
}

// cookbook-hwfit.js _requiresAcceleratorBackend: accelerator-only safetensors
// quants (AWQ / GPTQ / FP8 / NVFP4) can't run under llama.cpp/Ollama (which need
// GGUF) — they require vLLM or SGLang with a visible CUDA/ROCm accelerator. We
// match the same set against the model's compact quant tag and display name,
// the eliza analogues of upstream's quant/name/repo fields.
const ACCEL_MODE_TITLE =
  "Requires vLLM or SGLang with a visible CUDA/ROCm accelerator. " +
  "llama.cpp and Ollama need GGUF files.";

function requiresAcceleratorBackend(name: string, quant: string): boolean {
  const q = quant.toUpperCase();
  if (/^(AWQ|GPTQ|NVFP4)/.test(q) || q === "FP8") return true;
  return /\b(awq|gptq|fp8|nvfp4)\b/i.test(name);
}

// Compact tabular quant tag for the scan table's fixed-width QUANT column. The
// catalog's `quant` field is a marketing string for the Eliza-1 tiers ("Eliza-1
// optimized local runtime"), which overflows the column; the real per-model
// GGUF quant lives on the quantization matrix's defaultVariantId (e.g.
// "q4_k_m"), the same compact tag odysseus shows (Q4_K_M). Prefer that; fall
// back to `quant` only when it is already a short tabular tag (a single token,
// no spaces, e.g. a raw HF GGUF quant); otherwise show an honest "—".
function compactQuant(model: CatalogModel): string {
  const variant = model.quantization?.defaultVariantId;
  if (variant) return variant.toUpperCase();
  const raw = model.quant.trim();
  if (raw && !raw.includes(" ")) return raw.toUpperCase();
  return "—";
}

function toFitRow(model: CatalogModel, probe: HardwareProbe): FitRow {
  const fit = classifyFit(probe, model);
  const name = model.displayName || model.id;
  const quant = compactQuant(model);
  const accel = requiresAcceleratorBackend(name, quant);
  return {
    id: model.id,
    name,
    params: model.parameterLabel || model.params,
    quant,
    vramGb: model.sizeGb,
    contextK: model.contextLength
      ? Math.round(model.contextLength / 1024)
      : null,
    mode: accel ? "vLLM/SGLang" : probe.gpu ? probe.gpu.backend : "cpu only",
    modeTitle: accel ? ACCEL_MODE_TITLE : "",
    fit,
    fitRank: FIT_LEVEL_META[fit].rank,
  };
}

// Detected-hardware pills (cookbook.js #hwfit-hw-row + cookbook-hwfit
// _hwfitRenderHw). Built from the REAL probe; renders honest "No GPU" plus the
// real RAM / cores / arch facts. Never invents a GPU.
interface HwPill {
  key: string;
  label: string;
}

function hwPills(probe: HardwareProbe): HwPill[] {
  const pills: HwPill[] = [];
  if (probe.gpu) {
    pills.push({
      key: "gpu",
      label: `${probe.gpu.backend} · ${probe.gpu.totalVramGb.toFixed(1)} GB VRAM`,
    });
  } else {
    pills.push({ key: "gpu", label: "No GPU" });
  }
  pills.push({
    key: "ram",
    label: `${probe.freeRamGb.toFixed(1)} / ${probe.totalRamGb.toFixed(1)} GB RAM`,
  });
  pills.push({ key: "cores", label: `${probe.cpuCores} cores` });
  pills.push({ key: "arch", label: `${probe.platform}_${probe.arch}` });
  return pills;
}

type Loadable<T> = {
  status: "idle" | "loading" | "ready" | "error";
  data: T;
};

export function CookbookView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  // Wide workbench panel — the scan table needs FIT/MODEL/PARAM/QUANT/VRAM/CTX/
  // SPEED/SCORE/MODE across its width (odysseus opens at min(780px, 92vw)).
  const win = useWindowControls(
    "win-cookbook",
    { w: 780, h: 820 },
    { label: "Cookbook", icon: "BookOpen", onClose },
  );
  const [tab, setTab] = useState<CookbookTab>("download");

  // Download tab: collapsible Download card + scan toolbar state.
  const [downloadCardOpen, setDownloadCardOpen] = useState(false);
  const [trendingOpen, setTrendingOpen] = useState(false);
  const [repoInput, setRepoInput] = useState("");
  const [downloading, setDownloading] = useState(false);
  // Per-row uninstall busy flag (only the model being removed shows a spinner).
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [usecase, setUsecase] = useState("");
  const [scanQuery, setScanQuery] = useState("");
  const [engine, setEngine] = useState("");
  // FIT is the default-active sorted column upstream.
  const [fitSort, setFitSort] = useState("fit");
  const [fitReverse, setFitReverse] = useState(false);
  // Ctx target-context slider (cookbook-hwfit.js). Persisted as the preset value;
  // we map it back to a slider index, falling back to the default (50k) when no
  // saved value or an unknown one is stored.
  const [ctxIndex, setCtxIndex] = useState(() => {
    const saved = readPref<number | null>(PREF_KEYS.hwfitContext, null);
    if (saved == null) return CTX_DEFAULT_INDEX;
    const idx = CTX_PRESETS.indexOf(saved);
    return idx >= 0 ? idx : CTX_DEFAULT_INDEX;
  });

  // Serve tab toolbar state.
  const [serveSort, setServeSort] = useState("name");
  const [serveQuery, setServeQuery] = useState("");

  // Real backend surfaces.
  const [hardware, setHardware] = useState<Loadable<HardwareProbe | null>>({
    status: "idle",
    data: null,
  });
  const [catalog, setCatalog] = useState<Loadable<CatalogModel[]>>({
    status: "idle",
    data: [],
  });
  const [installed, setInstalled] = useState<Loadable<InstalledModel[]>>({
    status: "idle",
    data: [],
  });
  const [trending, setTrending] = useState<Loadable<CatalogModel[]>>({
    status: "idle",
    data: [],
  });
  type ProviderRow = Awaited<
    ReturnType<typeof client.getLocalInferenceProviders>
  >["providers"][number];
  const [providers, setProviders] = useState<Loadable<ProviderRow[]>>({
    status: "idle",
    data: [],
  });

  // Monotonic request token so a rapid RESCAN can't let a slower earlier probe
  // resolve after a newer one and clobber fresher hardware/catalog data.
  const hwReqToken = useRef(0);
  const loadHardware = useCallback(() => {
    const token = ++hwReqToken.current;
    setHardware((p) => ({ status: "loading", data: p.data }));
    setCatalog((p) => ({ status: "loading", data: p.data }));
    void client
      .getLocalInferenceHardware()
      .then((probe) => {
        if (token !== hwReqToken.current) return;
        setHardware({ status: "ready", data: probe });
      })
      .catch(() => {
        if (token !== hwReqToken.current) return;
        setHardware({ status: "error", data: null });
      });
    void client
      .getLocalInferenceCatalog()
      .then((r) => {
        if (token !== hwReqToken.current) return;
        setCatalog({ status: "ready", data: r.models });
      })
      .catch(() => {
        if (token !== hwReqToken.current) return;
        setCatalog({ status: "error", data: [] });
      });
  }, []);

  const loadInstalled = useCallback(() => {
    setInstalled((p) => ({ status: "loading", data: p.data }));
    void client
      .getLocalInferenceInstalled()
      .then((r) => setInstalled({ status: "ready", data: r.models }))
      .catch(() => setInstalled({ status: "error", data: [] }));
  }, []);

  const loadProviders = useCallback(() => {
    setProviders((p) => ({ status: "loading", data: p.data }));
    void client
      .getLocalInferenceProviders()
      .then((r) => setProviders({ status: "ready", data: r.providers }))
      .catch(() => setProviders({ status: "error", data: [] }));
  }, []);

  useEffect(() => {
    if (!open) return;
    loadHardware();
    loadInstalled();
    loadProviders();
  }, [open, loadHardware, loadInstalled, loadProviders]);

  // "Trending models that fit your hardware" — real HF GGUF search. Lazy-loaded
  // when the collapsible list first opens.
  const loadTrending = useCallback(() => {
    setTrending((p) => ({ status: "loading", data: p.data }));
    void client
      .searchHuggingFaceGguf("gguf", 20)
      .then((r) => setTrending({ status: "ready", data: r.models }))
      .catch(() => setTrending({ status: "error", data: [] }));
  }, []);

  const toggleTrending = () => {
    setTrendingOpen((openNow) => {
      const next = !openNow;
      if (next && trending.status === "idle") loadTrending();
      return next;
    });
  };

  // Real Download — paste a HF repo/URL, hit Download.
  // client.startLocalInferenceDownload kicks off the real download job.
  const startDownload = () => {
    const spec = repoInput.trim();
    if (!spec || downloading) return;
    setDownloading(true);
    void client
      .startLocalInferenceDownload(spec)
      .then(() => {
        setRepoInput("");
        loadInstalled();
      })
      .catch(() => {
        /* download failed to enqueue — the input stays so the user can retry */
      })
      .finally(() => setDownloading(false));
  };

  // odysseus cookbookServe's per-model uninstall — removes a cached GGUF via the
  // real client method, then refreshes the installed list (mirrors startDownload).
  const uninstallModel = (id: string, name: string) => {
    if (removingId) return;
    if (!window.confirm(`Remove the cached model "${name}"?`)) return;
    setRemovingId(id);
    void client
      .uninstallLocalInferenceModel(id)
      .then(() => loadInstalled())
      .catch(() => {
        /* uninstall failed — the row stays so the user can retry */
      })
      .finally(() => setRemovingId(null));
  };

  // cookbook-hwfit.js context slider change: persist the chosen preset and force
  // the sort to fit-descending (best-fit first). Upstream also re-runs the scan
  // against the new context budget, but eliza's classifyFit is not context-aware
  // (the runtime contract has no per-context fit probe), so re-probing would
  // change nothing — we persist + sort only and disable the slider below.
  const onCtxChange = (index: number) => {
    setCtxIndex(index);
    writePref(PREF_KEYS.hwfitContext, CTX_PRESETS[index]);
    setFitSort("fit");
    setFitReverse(false);
  };

  // cookbook-hwfit.js header click: clicking the active column flips direction,
  // clicking a new column resets to highest-first.
  const onSortColumn = (key: string | null) => {
    if (!key) return;
    if (fitSort === key) {
      setFitReverse((v) => !v);
    } else {
      setFitSort(key);
      setFitReverse(false);
    }
  };

  // Scan table rows, filtered + sorted client-side (faithful to odysseus's
  // client-side hwfit filtering). Only renders when a real probe + catalog are
  // present — never fabricates rows.
  const fitRows = useMemo(() => {
    const probe = hardware.data;
    if (!probe) return [];
    const q = scanQuery.trim().toLowerCase();
    const rows = catalog.data
      .filter((m) => !m.hiddenFromCatalog)
      .filter((m) => (usecase ? matchesUsecase(m, usecase) : true))
      .filter((m) =>
        q
          ? (m.displayName || m.id).toLowerCase().includes(q) ||
            m.hfRepo.toLowerCase().includes(q)
          : true,
      )
      .map((m) => toFitRow(m, probe))
      // Engine filter (cookbook-hwfit.js _applyEngineFilter). FitRow.mode already
      // classifies the backend: accelerator-only quants → "vLLM/SGLang", the
      // rest run under llama.cpp/Ollama. vLLM/SGLang select the accel rows;
      // llama.cpp selects the GGUF rows.
      .filter((row) =>
        engine === "vllm" || engine === "sglang"
          ? row.mode === "vLLM/SGLang"
          : engine === "llamacpp"
            ? row.mode !== "vLLM/SGLang"
            : true,
      );
    const dir = fitReverse ? -1 : 1;
    rows.sort((a, b) => dir * compareFitRows(a, b, fitSort));
    return rows;
  }, [
    hardware.data,
    catalog.data,
    scanQuery,
    usecase,
    engine,
    fitSort,
    fitReverse,
  ]);

  const installedRows = useMemo(() => {
    const q = serveQuery.trim().toLowerCase();
    const rows = installed.data.filter((m) =>
      q ? (m.displayName || m.id).toLowerCase().includes(q) : true,
    );
    rows.sort((a, b) => compareInstalled(a, b, serveSort));
    return rows;
  }, [installed.data, serveQuery, serveSort]);

  if (!open) return null;
  if (win.minimized) return null;

  const probe = hardware.data;
  const pills = probe ? hwPills(probe) : [];

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Cookbook"
    >
      <button
        type="button"
        aria-label="Close cookbook"
        onClick={onClose}
        className="od-search-backdrop"
      />
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}
      <div className="od-search-panel od-cb-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />

        {/* ── Header (cookbook-modal .modal-header: book glyph + title + close).
            No recipe count, no header refresh — refresh is the Scan toolbar's
            RESCAN button (cookbook.js index.html L1293-1294). ── */}
        <div
          className="od-cb-head od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-cb-title">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              role="img"
              aria-label="Cookbook"
              className="od-cb-title-icon"
            >
              <path d="M12 7v14" />
              <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
            </svg>
            Cookbook
          </span>
          <span className="od-cb-head-spacer" />
          <button
            type="button"
            className="od-window-min-btn"
            onClick={win.minimize}
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="od-cb-close"
            aria-label="Close cookbook"
            title="Close"
            onClick={onClose}
          >
            ✖
          </button>
        </div>

        {/* ── Tab row (cookbook.js .cookbook-tab set) ── */}
        <div className="od-cb-tabs" role="tablist" aria-label="Cookbook tabs">
          {COOKBOOK_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`od-cb-tab${tab === t.id ? " od-cb-tab-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              <span className="od-cb-tab-icon" aria-hidden="true">
                {t.icon}
              </span>
              {t.label}
            </button>
          ))}
        </div>

        <div className="od-cb-body">
          {/* ════ Download tab (cookbook.js data-backend-group="Search") ════ */}
          {tab === "download" ? (
            <>
              {/* Collapsible Download admin-card (cookbook.js 1435-1499) */}
              <div className="od-cb-card-section">
                <button
                  type="button"
                  className="od-cb-section-toggle"
                  aria-expanded={downloadCardOpen}
                  onClick={() => setDownloadCardOpen((v) => !v)}
                >
                  <span className="od-cb-section-h2">Download</span>
                  <span
                    className={`od-cb-section-arrow${downloadCardOpen ? " od-cb-section-arrow-open" : ""}`}
                    aria-hidden="true"
                  >
                    ▸
                  </span>
                </button>
                {downloadCardOpen ? (
                  <div className="od-cb-section-body">
                    <div className="od-cb-dl-serverrow">
                      <select
                        className="od-cb-select"
                        aria-label="Download server"
                        value="local"
                        disabled
                      >
                        <option value="local">Local</option>
                      </select>
                      <button
                        type="button"
                        className="od-cb-toolbar-btn"
                        title="Add server in Settings"
                        onClick={() => setTab("settings")}
                      >
                        <Server size={12} />
                      </button>
                    </div>
                    <div className="od-cb-dl-input">
                      <input
                        type="text"
                        className="od-cb-field-input"
                        value={repoInput}
                        onChange={(e) => setRepoInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") startDownload();
                        }}
                        placeholder="HF repo or URL"
                        aria-label="Model repo or HuggingFace URL"
                      />
                      <button
                        type="button"
                        className="od-cb-dl-btn"
                        onClick={startDownload}
                        disabled={!repoInput.trim() || downloading}
                      >
                        {downloading ? "Downloading…" : "Download"}
                      </button>
                    </div>
                    {/* Trending models that fit — real HF GGUF search */}
                    <div className="od-cb-trending">
                      <button
                        type="button"
                        className="od-cb-toolbar-btn od-cb-trending-toggle"
                        aria-expanded={trendingOpen}
                        onClick={toggleTrending}
                      >
                        <span
                          className={`od-cb-section-arrow${trendingOpen ? " od-cb-section-arrow-open" : ""}`}
                          aria-hidden="true"
                        >
                          ▸
                        </span>
                        Fits hardware
                      </button>
                      {trendingOpen ? (
                        <div className="od-cb-trending-list">
                          {trending.status === "loading" ? (
                            <div className="od-cb-loading">
                              Scanning models…
                            </div>
                          ) : trending.status === "error" ? (
                            <div className="od-cb-loading">
                              Couldn't reach HuggingFace search.
                            </div>
                          ) : trending.data.length === 0 ? (
                            <div className="od-cb-loading">
                              No trending models found.
                            </div>
                          ) : (
                            trending.data.map((m) => (
                              <button
                                type="button"
                                key={m.id}
                                className="od-cb-trending-row"
                                title={m.hfRepo}
                                onClick={() => setRepoInput(m.hfRepo)}
                              >
                                <span className="od-cb-trending-name">
                                  {m.displayName || m.id}
                                </span>
                                <span className="od-cb-trending-meta">
                                  {m.quant} · {m.sizeGb.toFixed(1)}G
                                </span>
                              </button>
                            ))
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Scan / Download admin-card (cookbook.js Search section) */}
              <div className="od-cb-card-section od-cb-scan-section">
                <span className="od-cb-section-h2">Scan / Download</span>
                {/* Toolbar row 1: Type / Search / Quant / Engine */}
                <div className="od-cb-toolbar">
                  <select
                    className="od-cb-field-input od-cb-usecase"
                    value={usecase}
                    onChange={(e) => setUsecase(e.target.value)}
                    aria-label="Use case"
                  >
                    {USECASE_OPTIONS.map((o) => (
                      <option key={o.label} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    className="od-cb-field-input od-cb-scan-search"
                    value={scanQuery}
                    onChange={(e) => setScanQuery(e.target.value)}
                    placeholder="Search models..."
                    aria-label="Search models"
                  />
                  <select
                    className="od-cb-field-input od-cb-quant"
                    value="Q4_K_M"
                    aria-label="Quantization"
                    title="Catalog quant is fixed"
                    disabled
                  >
                    {QUANT_OPTIONS.map((o) => (
                      <option key={o.label} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="od-cb-field-input od-cb-engine"
                    value={engine}
                    onChange={(e) => setEngine(e.target.value)}
                    aria-label="Serving engine"
                    title="Filter by serving engine"
                  >
                    {ENGINE_OPTIONS.map((o) => (
                      <option key={o.label} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <span className="od-cb-help-chip" title="Quality vs memory">
                    ?
                  </span>
                  {/* Ctx target-context slider (cookbook-hwfit.js #hwfit-context).
                      Disabled: eliza's fit estimate isn't context-aware, so the
                      chosen context can't change which models fit. */}
                  <label className="od-cb-ctx-control" title="Context length">
                    <span>Ctx</span>
                    <span
                      className="od-cb-help-chip od-cb-help-chip-inline"
                      title="Context length"
                    >
                      ?
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={CTX_PRESETS.length - 1}
                      step={1}
                      value={ctxIndex}
                      onChange={(e) => onCtxChange(Number(e.target.value))}
                      aria-label="Target context length"
                      title="Context length"
                      disabled
                    />
                    <output>{ctxLabel(CTX_PRESETS[ctxIndex])}</output>
                  </label>
                </div>

                {/* Toolbar row 2: server / RESCAN / EDIT */}
                <div className="od-cb-toolbar">
                  <select
                    className="od-cb-field-input od-cb-server-select"
                    aria-label="Scan server"
                    value="local"
                    disabled
                  >
                    <option value="local">Local</option>
                  </select>
                  <span className="od-cb-toolbar-spacer" />
                  <button
                    type="button"
                    className="od-cb-gpu-btn od-cb-rescan"
                    title="Re-scan hardware"
                    onClick={loadHardware}
                    disabled={hardware.status === "loading"}
                  >
                    <RefreshCw
                      size={12}
                      className={
                        hardware.status === "loading" ? "od-cb-spin" : ""
                      }
                    />
                    RESCAN
                  </button>
                  <button
                    type="button"
                    className="od-cb-gpu-btn od-cb-edit"
                    title="Manual hardware override unavailable"
                    disabled
                  >
                    EDIT
                  </button>
                </div>

                {/* Detected-hardware pill row (cookbook.js #hwfit-hw-row) */}
                {pills.length > 0 ? (
                  <div className="od-cb-hw-row">
                    <span className="od-cb-hw-label">Detected hardware</span>
                    <div className="od-cb-hw-pills">
                      {pills.map((p) => (
                        <span className="od-cb-hw-pill" key={p.key}>
                          {p.label}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {/* Scan table (cookbook-hwfit.js _hwfitRenderList) */}
                <div className="od-cb-fit-table">
                  <div className="od-cb-fit-row od-cb-fit-header">
                    {FIT_COLUMNS.map((col) => {
                      const sortable = col.sortKey ? " od-cb-fit-sortable" : "";
                      const active =
                        col.sortKey && col.sortKey === fitSort
                          ? " od-cb-fit-sort-active"
                          : "";
                      const arrow =
                        col.sortKey === fitSort
                          ? fitReverse
                            ? " ▲"
                            : " ▼"
                          : "";
                      return (
                        <button
                          key={col.label}
                          type="button"
                          className={`od-cb-fit-col ${col.cls}${sortable}${active}`}
                          onClick={() => onSortColumn(col.sortKey)}
                          disabled={!col.sortKey}
                        >
                          {col.label}
                          {arrow}
                        </button>
                      );
                    })}
                  </div>
                  {hardware.status === "loading" ||
                  catalog.status === "loading" ? (
                    <div className="od-cb-loading">Scanning hardware…</div>
                  ) : hardware.status === "error" ? (
                    <div className="od-cb-loading">Hardware probe offline.</div>
                  ) : fitRows.length === 0 ? (
                    <div className="od-cb-loading">
                      {scanQuery.trim() || usecase
                        ? "No matches."
                        : "No models fit your hardware."}
                    </div>
                  ) : (
                    fitRows.map((row) => (
                      <div className="od-cb-fit-row" key={row.id}>
                        <span
                          className={`od-cb-fit-col od-cb-fit-fit ${FIT_LEVEL_META[row.fit].cls}`}
                        >
                          {FIT_LEVEL_META[row.fit].label}
                        </span>
                        <span
                          className="od-cb-fit-col od-cb-fit-name"
                          title={row.name}
                        >
                          {row.name}
                        </span>
                        <span className="od-cb-fit-col od-cb-fit-params">
                          {row.params}
                        </span>
                        <span className="od-cb-fit-col od-cb-fit-quant">
                          {row.quant}
                        </span>
                        <span className="od-cb-fit-col od-cb-fit-vram">
                          {row.vramGb.toFixed(1)}G
                        </span>
                        <span className="od-cb-fit-col od-cb-fit-ctx">
                          {row.contextK ? `${row.contextK}k` : "?"}
                        </span>
                        <span className="od-cb-fit-col od-cb-fit-speed">—</span>
                        <span className="od-cb-fit-col od-cb-fit-score">—</span>
                        <span
                          className="od-cb-fit-col od-cb-fit-mode"
                          title={row.modeTitle || undefined}
                        >
                          {row.mode}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          ) : null}

          {/* ════ Serve tab (cookbook.js data-backend-group="Serve") ════ */}
          {tab === "serve" ? (
            <div className="od-cb-card-section">
              <span className="od-cb-section-h2">
                Serve
                {installed.status === "ready" ? (
                  <span className="od-cb-section-count">
                    {installed.data.length}
                  </span>
                ) : null}
              </span>
              <div className="od-cb-toolbar">
                <input
                  type="text"
                  className="od-cb-field-input od-cb-scan-search"
                  value={serveQuery}
                  onChange={(e) => setServeQuery(e.target.value)}
                  placeholder="Search cached models…"
                  aria-label="Search cached models"
                />
                <select
                  className="od-cb-field-input od-cb-quant"
                  value={serveSort}
                  onChange={(e) => setServeSort(e.target.value)}
                  aria-label="Sort cached models"
                >
                  {SERVE_SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="od-cb-toolbar-btn"
                  title="Refresh cached models"
                  onClick={loadInstalled}
                  disabled={installed.status === "loading"}
                >
                  <RefreshCw
                    size={12}
                    className={
                      installed.status === "loading" ? "od-cb-spin" : ""
                    }
                  />
                </button>
              </div>
              <div className="od-cb-serve-list">
                {installed.status === "loading" ? (
                  <div className="od-cb-loading">Loading cached models…</div>
                ) : installed.status === "error" ? (
                  <div className="od-cb-loading">Serve runtime offline.</div>
                ) : installedRows.length === 0 ? (
                  <div className="od-cb-loading">No cached models.</div>
                ) : (
                  installedRows.map((m) => (
                    <div className="od-cb-card" key={m.id}>
                      <div className="od-cb-serve-card-main">
                        <span className="od-cb-serve-card-name" title={m.path}>
                          {m.displayName || m.id}
                        </span>
                        <span className="od-cb-serve-card-size">
                          {(m.sizeBytes / 1e9).toFixed(1)} GB
                        </span>
                        <button
                          type="button"
                          className="od-cb-serve-card-uninstall"
                          aria-label={`Uninstall ${m.displayName || m.id}`}
                          title="Uninstall this cached model"
                          disabled={removingId !== null}
                          aria-busy={removingId === m.id}
                          onClick={() =>
                            uninstallModel(m.id, m.displayName || m.id)
                          }
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      {m.hfRepo ? (
                        <span className="od-cb-serve-card-repo">
                          {m.hfRepo}
                        </span>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}

          {/* ════ Dependencies tab (cookbook.js data-backend-group="Dependencies") ════ */}
          {tab === "dependencies" ? (
            <div className="od-cb-card-section">
              <div className="od-cb-deps-head">
                <span className="od-cb-section-h2">Dependencies</span>
                <select
                  className="od-cb-field-input od-cb-deps-server"
                  aria-label="Dependencies server"
                  value="local"
                  disabled
                >
                  <option value="local">Local</option>
                </select>
              </div>
              <div className="od-cb-deps-grid">
                <div className="od-cb-loading">Package manager offline.</div>
              </div>
            </div>
          ) : null}

          {/* ════ Settings tab (cookbook.js data-backend-group="Settings") ════ */}
          {tab === "settings" ? (
            <div className="od-cb-settings-stack">
              {/* HuggingFace Token block */}
              <div className="od-cb-card-section">
                <span className="od-cb-section-h2">HuggingFace Token</span>
                <input
                  type="password"
                  className="od-cb-field-input"
                  placeholder="hf_..."
                  aria-label="HuggingFace token"
                  disabled
                />
              </div>

              {/* Servers block — real local-inference provider registry */}
              <div className="od-cb-card-section">
                <div className="od-cb-deps-head">
                  <span className="od-cb-section-h2">Servers</span>
                  <button
                    type="button"
                    className="od-cb-toolbar-btn od-cb-server-refresh"
                    title="Refresh providers"
                    onClick={loadProviders}
                    disabled={providers.status === "loading"}
                  >
                    <RefreshCw
                      size={12}
                      className={
                        providers.status === "loading" ? "od-cb-spin" : ""
                      }
                    />
                  </button>
                </div>
                <div className="od-cb-servers-list">
                  {providers.status === "loading" ? (
                    <div className="od-cb-loading">Loading providers…</div>
                  ) : providers.status === "error" ? (
                    <div className="od-cb-loading">
                      Provider registry offline.
                    </div>
                  ) : providers.data.length === 0 ? (
                    <div className="od-cb-loading">
                      No inference providers configured.
                    </div>
                  ) : (
                    providers.data.map((p) => (
                      <div className="od-cb-server-row" key={p.id}>
                        <div className="od-cb-server-main">
                          <span className="od-cb-server-name">{p.label}</span>
                          <span
                            className={`od-cb-server-state${p.enableState.enabled ? " od-cb-server-on" : " od-cb-server-off"}`}
                            title={p.enableState.reason}
                          >
                            {p.enableState.enabled ? "ready" : "off"}
                          </span>
                        </div>
                        {p.description ? (
                          <span className="od-cb-server-desc">
                            {p.description}
                          </span>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// cookbook-hwfit use-case filter — maps odysseus's use-case axis onto eliza's
// real CatalogModel.category. "general"/"chat" accept the chat tier; "coding"
// the code tier; "reasoning" the reasoning tier; "multimodal" (Vision) has no
// eliza catalog analogue, so it intentionally matches nothing rather than
// inventing a vision tier.
function matchesUsecase(model: CatalogModel, usecase: string): boolean {
  switch (usecase) {
    case "coding":
      return model.category === "code";
    case "reasoning":
      return model.category === "reasoning";
    case "chat":
    case "general":
      return model.category === "chat" || model.category === "tiny";
    case "multimodal":
      return false;
    default:
      return true;
  }
}

// Column comparator for the scan table (highest-first before the reverse flag).
function compareFitRows(a: FitRow, b: FitRow, key: string): number {
  switch (key) {
    case "fit":
      return b.fitRank - a.fitRank;
    case "params":
      return paramSize(b.params) - paramSize(a.params);
    case "vram":
      return b.vramGb - a.vramGb;
    case "context":
      return (b.contextK ?? 0) - (a.contextK ?? 0);
    default:
      return (a.name || "").localeCompare(b.name || "");
  }
}

// Parse a "7B" / "0.5B" / "360M" param label into a comparable GB-scale number.
function paramSize(label: string): number {
  const m = label.match(/([\d.]+)\s*([BM])/i);
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  if (Number.isNaN(n)) return 0;
  return m[2].toUpperCase() === "M" ? n / 1000 : n;
}

function compareInstalled(
  a: InstalledModel,
  b: InstalledModel,
  key: string,
): number {
  switch (key) {
    case "size-desc":
      return b.sizeBytes - a.sizeBytes;
    case "size-asc":
      return a.sizeBytes - b.sizeBytes;
    case "recent": {
      const at = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
      const bt = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
      return bt - at;
    }
    default:
      return (a.displayName || a.id).localeCompare(b.displayName || b.id);
  }
}
