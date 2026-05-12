import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const VAST_PYWORKER_DIR = join(__dirname, "..", "..", "services", "vast-pyworker");
export const VAST_MANIFEST_DIR = join(VAST_PYWORKER_DIR, "manifests");

export interface VastManifestSearchParams {
  gpu_name?: string[];
  num_gpus?: string | number;
  gpu_ram?: string | number;
  disk_space?: string | number;
  inet_down?: string | number;
  reliability?: string | number;
  verified?: boolean;
  [key: string]: unknown;
}

export interface VastServeManifest {
  label?: string;
  model_size?: string;
  model?: string;
  model_repo?: string;
  model_alias?: string;
  served_model_name?: string;
  registry_key?: string;
  gpu_target?: string;
  image?: string;
  min_disk_gb?: number;
  min_inet_down_mbps?: number;
  port?: number;
  health_check_url?: string;
  tensor_parallel_size?: number;
  expert_parallel_size?: number;
  gpu_memory_utilization?: number;
  max_model_len?: number;
  weight_quantization?: string;
  kv_cache_dtype?: string;
  enable_turboquant?: boolean;
  turboquant_preset?: string;
  tool_parser?: string;
  reasoning_parser?: string;
  compilation_config?: Record<string, unknown>;
  additional_config?: Record<string, unknown>;
  search_params?: VastManifestSearchParams;
  vast_template_env?: Record<string, string>;
  onstart_script?: string;
  notes?: string;
}

export interface LoadedVastManifest {
  name: string;
  path: string;
  json: string;
  manifest: VastServeManifest;
}

export function resolveManifestPath(manifest: string): string {
  if (isAbsolute(manifest)) return manifest;
  return join(VAST_MANIFEST_DIR, manifest);
}

export function readVastManifest(name = "eliza-1-2b.json"): LoadedVastManifest {
  const path = resolveManifestPath(name);
  const json = readFileSync(path, "utf8");
  return {
    name,
    path,
    json: JSON.stringify(JSON.parse(json)),
    manifest: JSON.parse(json) as VastServeManifest,
  };
}

export function listVastManifestFiles(): string[] {
  return readdirSync(VAST_MANIFEST_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort();
}

export function listVastManifests(): LoadedVastManifest[] {
  return listVastManifestFiles().map((file) => readVastManifest(file));
}

export function parseConstraintNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function manifestGpuRamGb(manifest: VastServeManifest): number {
  const raw = parseConstraintNumber(manifest.search_params?.gpu_ram);
  if (!raw || raw <= 0) return 24;
  // Existing manifests use marketplace-style MiB values (24000, 90000,
  // 180000). Vast workergroups accept the model requirement in GiB.
  return raw > 1024 ? Math.ceil(raw / 1024) : Math.ceil(raw);
}

export function manifestDiskGb(manifest: VastServeManifest): number {
  const diskFromSearch = parseConstraintNumber(manifest.search_params?.disk_space);
  return Math.ceil(diskFromSearch ?? manifest.min_disk_gb ?? 60);
}

export function manifestSearchParamsToQuery(manifest: VastServeManifest): string {
  const params = manifest.search_params ?? {};
  const parts: string[] = [];

  if (Array.isArray(params.gpu_name) && params.gpu_name.length > 0) {
    parts.push(`gpu_name in [${params.gpu_name.join(",")}]`);
  }

  for (const key of ["num_gpus", "gpu_ram", "disk_space", "inet_down", "reliability"] as const) {
    const value = params[key];
    if (value === undefined || value === null || value === "") continue;
    const rendered = typeof value === "number" ? `>=${value}` : String(value).trim();
    parts.push(
      `${key}${rendered.startsWith(">") || rendered.startsWith("<") ? "" : "="}${rendered}`,
    );
  }

  if (typeof params.verified === "boolean") {
    parts.push(`verified=${params.verified ? "true" : "false"}`);
  }

  return parts.join(" ");
}
