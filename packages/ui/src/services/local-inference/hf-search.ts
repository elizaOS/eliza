/**
 * HuggingFace Hub search for GGUF models.
 *
 * Calls `https://huggingface.co/api/models` with `filter=gguf` to narrow
 * results to repos that actually ship GGUF quantisations. Each matching
 * repo is expanded with `/api/models/<repo>` to pick a representative
 * quant file (preferring Q4_K_M when present). Results are shaped like
 * `CatalogModel` so the existing ModelCard renders them directly.
 *
 * We deliberately do not persist these — they're dynamic, and a curated
 * entry with the same hfRepo always takes precedence in the UI.
 */

import type { CatalogModel, ModelBucket } from "./types";

const HF_API = "https://huggingface.co/api";
const SEARCH_TIMEOUT_MS = 10_000;

interface HfSearchResultRaw {
  id?: string;
  modelId?: string;
  author?: string;
  likes?: number;
  downloads?: number;
  tags?: string[];
  pipeline_tag?: string;
}

interface HfSiblingRaw {
  rfilename?: string;
  size?: number;
}

interface HfModelDetailRaw {
  id?: string;
  author?: string;
  tags?: string[];
  siblings?: HfSiblingRaw[];
  pipeline_tag?: string;
  likes?: number;
  downloads?: number;
}

interface ModelScopeEnvelope<T> {
  Code?: number;
  Message?: string;
  Data?: T;
}

interface ModelScopeModelRaw {
  ModelId?: string;
  model_id?: string;
  Name?: string;
  Path?: string;
  Downloads?: number;
  Tags?: string[];
  Tasks?: string[];
  Frameworks?: string[];
}

interface ModelScopeListRaw {
  Models?: ModelScopeModelRaw[];
}

interface ModelScopeFileRaw {
  Name?: string;
  Path?: string;
  Size?: number;
}

interface ModelScopeFilesRaw {
  Files?: ModelScopeFileRaw[];
}

const QUANT_PREFERENCE = [
  "Q4_K_M",
  "Q5_K_M",
  "Q4_0",
  "Q5_0",
  "Q3_K_M",
  "Q8_0",
  "Q2_K",
];

function pickQuantFile(siblings: HfSiblingRaw[]): HfSiblingRaw | null {
  const ggufs = siblings.filter((s) =>
    s.rfilename?.toLowerCase().endsWith(".gguf"),
  );
  if (ggufs.length === 0) return null;

  for (const quant of QUANT_PREFERENCE) {
    const match = ggufs.find((s) => s.rfilename?.toUpperCase().includes(quant));
    if (match) return match;
  }
  // No preferred quant — pick the smallest GGUF so we don't surprise the
  // user with a 40 GB file.
  return [...ggufs].sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0] ?? null;
}

function extractQuantLabel(filename: string): string {
  for (const quant of QUANT_PREFERENCE) {
    if (filename.toUpperCase().includes(quant)) return quant;
  }
  return "GGUF";
}

/**
 * Very rough parameter-count inference from model name / tags. We use this
 * only to pick a bucket label — not for any hard memory check.
 */
function inferParams(
  name: string,
  tags: string[],
): { params: CatalogModel["params"]; bucket: ModelBucket } {
  const lower = `${name} ${tags.join(" ")}`.toLowerCase();
  const sizes: Array<[RegExp, CatalogModel["params"], ModelBucket]> = [
    [/\b32b\b/, "32B", "xl"],
    [/\b27b\b/, "27B", "large"],
    [/\b24b\b/, "24B", "large"],
    [/\b22b\b/, "22B", "large"],
    [/\b16b\b/, "16B", "large"],
    [/\b14b\b/, "14B", "large"],
    [/\b13b\b/, "14B", "large"],
    [/\b9b\b/, "9B", "mid"],
    [/\b0\.6b\b/, "0.6B", "small"],
    [/\b0\.8b\b/, "0.8B", "small"],
    [/\b1\.7b\b/, "1.7B", "small"],
    [/\b8b\b/, "8B", "mid"],
    [/\b7b\b/, "7B", "mid"],
    [/\b3b\b/, "3B", "small"],
    [/\b2b\b/, "2B", "small"],
    [/\b1b\b/, "1B", "small"],
  ];
  for (const [re, params, bucket] of sizes) {
    if (re.test(lower)) return { params, bucket };
  }
  return { params: "7B", bucket: "mid" };
}

function inferCategory(
  tags: string[],
  pipelineTag: string | undefined,
): CatalogModel["category"] {
  const lowerTags = tags.map((t) => t.toLowerCase());
  if (lowerTags.some((t) => t.includes("code") || t.includes("coder"))) {
    return "code";
  }
  if (
    lowerTags.some(
      (t) => t.includes("reasoning") || t === "math" || t.includes("r1"),
    )
  ) {
    return "reasoning";
  }
  if (
    lowerTags.some(
      (t) =>
        t.includes("function") || t.includes("tool") || t.includes("hermes"),
    )
  ) {
    return "tools";
  }
  if (pipelineTag === "text-generation") {
    return "chat";
  }
  return "chat";
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search HuggingFace for GGUF repos matching `query`, returning
 * catalog-shaped entries ready for the Model Hub UI.
 */
export async function searchHuggingFaceGguf(
  query: string,
  limit = 12,
): Promise<CatalogModel[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const searchUrl = new URL(`${HF_API}/models`);
  searchUrl.searchParams.set("search", trimmed);
  searchUrl.searchParams.set("filter", "gguf");
  searchUrl.searchParams.set(
    "limit",
    String(Math.min(50, Math.max(1, limit * 2))),
  );
  searchUrl.searchParams.set("sort", "downloads");
  searchUrl.searchParams.set("direction", "-1");

  const searchRes = await fetchWithTimeout(searchUrl.toString(), {
    headers: { accept: "application/json" },
  });
  if (!searchRes.ok) {
    throw new Error(`Hugging Face search failed: HTTP ${searchRes.status}`);
  }
  const rawList = (await searchRes.json()) as HfSearchResultRaw[];
  const candidates = rawList
    .map((r) => r.id ?? r.modelId)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .slice(0, limit);

  // Parallel detail fetches; failures drop quietly so one bad repo doesn't
  // take down the whole search.
  const details = await Promise.all(
    candidates.map(async (id) => {
      try {
        const res = await fetchWithTimeout(
          `${HF_API}/models/${encodeURIComponent(id)}`,
          { headers: { accept: "application/json" } },
        );
        if (!res.ok) return null;
        return (await res.json()) as HfModelDetailRaw;
      } catch {
        return null;
      }
    }),
  );

  const results: CatalogModel[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i];
    const detail = details[i];
    if (!id || !detail?.siblings) continue;
    const sibling = pickQuantFile(detail.siblings);
    if (!sibling?.rfilename) continue;

    const sizeBytes = sibling.size ?? 0;
    const sizeGb = sizeBytes > 0 ? sizeBytes / 1024 ** 3 : 4;
    const { params, bucket } = inferParams(id, detail.tags ?? []);
    const quant = extractQuantLabel(sibling.rfilename);
    const category = inferCategory(detail.tags ?? [], detail.pipeline_tag);
    const displayName = id.split("/").pop() ?? id;

    // minRam heuristic: 2x the file size, minimum 4 GB. Close enough for
    // the fit badge; the ModelCard's fit computation still does the work.
    const minRamGb = Math.max(4, Math.round(sizeGb * 2));

    results.push({
      id: `hf:${id}::${sibling.rfilename}`,
      displayName,
      hfRepo: id,
      ggufFile: sibling.rfilename,
      params,
      quant,
      sizeGb: Math.round(sizeGb * 10) / 10,
      minRamGb,
      category,
      bucket,
      blurb:
        (detail.tags ?? []).slice(0, 4).join(" · ") ||
        `${detail.downloads ?? 0} downloads · ${detail.likes ?? 0} likes`,
    });
  }
  return results;
}

function normalizeModelScopeRepoId(query: string): string | null {
  const trimmed = query.trim().replace(/^modelscope:\/\//i, "");
  const match = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.exec(trimmed);
  return match ? trimmed : null;
}

function modelScopeOwnerQuery(query: string): string | null {
  const trimmed = query.trim().replace(/^modelscope:\/\//i, "");
  const first = trimmed.split(/\s+/)[0] ?? "";
  if (/^[A-Za-z0-9_.-]+$/.test(first)) return first;
  return null;
}

function pickModelScopeGguf(files: ModelScopeFileRaw[]): HfSiblingRaw | null {
  return pickQuantFile(
    files.map((file) => ({
      rfilename: file.Path ?? file.Name,
      size: file.Size,
    })),
  );
}

async function fetchModelScopeJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  const res = await fetchWithTimeout(url, {
    ...init,
    headers,
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`ModelScope request failed: HTTP ${res.status}`);
  }
  const envelope = (await res.json()) as ModelScopeEnvelope<T>;
  if (envelope.Code !== 200 || envelope.Data === undefined) {
    throw new Error(envelope.Message ?? "ModelScope request failed");
  }
  return envelope.Data;
}

async function listModelScopeOwnerModels(
  owner: string,
  limit: number,
): Promise<string[]> {
  const data = await fetchModelScopeJson<ModelScopeListRaw>(
    "https://www.modelscope.cn/api/v1/models",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        Path: owner,
        PageNumber: 1,
        PageSize: Math.min(50, Math.max(1, limit * 3)),
      }),
    },
  );
  return (data.Models ?? [])
    .map((m) => m.ModelId ?? m.model_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function modelScopeResultForRepo(
  repoId: string,
): Promise<CatalogModel | null> {
  const filesData = await fetchModelScopeJson<ModelScopeFilesRaw>(
    `https://www.modelscope.cn/api/v1/models/${repoId}/repo/files?Revision=master&Recursive=true`,
  );
  const sibling = pickModelScopeGguf(filesData.Files ?? []);
  if (!sibling?.rfilename) return null;

  const sizeBytes = sibling.size ?? 0;
  const sizeGb = sizeBytes > 0 ? sizeBytes / 1024 ** 3 : 4;
  const { params, bucket } = inferParams(repoId, []);
  const quant = extractQuantLabel(sibling.rfilename);
  const displayName = repoId.split("/").pop() ?? repoId;

  return {
    id: `modelscope:${repoId}::${sibling.rfilename}`,
    displayName,
    hub: "modelscope",
    hfRepo: repoId,
    ggufFile: sibling.rfilename,
    params,
    quant,
    sizeGb: Math.round(sizeGb * 10) / 10,
    minRamGb: Math.max(4, Math.round(sizeGb * 2)),
    category: "chat",
    bucket,
    blurb: "ModelScope GGUF result · explicit opt-in only",
  };
}

/**
 * Search ModelScope for GGUF repos. ModelScope exposes reliable owner-list
 * and repo-file APIs, so this accepts either `owner/model` or an owner name
 * and filters the returned repos for GGUF files.
 */
export async function searchModelScopeGguf(
  query: string,
  limit = 12,
): Promise<CatalogModel[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const direct = normalizeModelScopeRepoId(trimmed);
  const repoIds = direct
    ? [direct]
    : await listModelScopeOwnerModels(
        modelScopeOwnerQuery(trimmed) ?? trimmed,
        limit,
      );

  const results = await Promise.all(
    repoIds.slice(0, Math.min(50, limit * 3)).map(async (id) => {
      try {
        return await modelScopeResultForRepo(id);
      } catch {
        return null;
      }
    }),
  );

  return results
    .filter((model): model is CatalogModel => Boolean(model))
    .slice(0, limit);
}

export async function searchModelHubGguf(
  query: string,
  hub: "huggingface" | "modelscope" = "huggingface",
  limit = 12,
): Promise<CatalogModel[]> {
  return hub === "modelscope"
    ? searchModelScopeGguf(query, limit)
    : searchHuggingFaceGguf(query, limit);
}
