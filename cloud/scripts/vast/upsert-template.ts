/**
 * Idempotent Vast.ai template upsert for the Eliza-1 27B serving
 * stack. The template is the per-worker spec that Vast Serverless instantiates
 * on each cold start: image, disk, env, on_start script.
 *
 * Why we commit this:
 *   - Reproducibility. The template defines what code/model runs on every
 *     worker. Without this script, a single accidental click in the Vast UI
 *     can change the served model and there's no audit trail.
 *   - Disaster recovery. If the template id is lost, re-running this script
 *     recreates an identical one in seconds.
 *
 * Required env:
 *   VASTAI_API_KEY     — vast CLI key (starts with `vastai_`).
 *
 * Optional env:
 *   VAST_TEMPLATE_NAME — defaults to "eliza-cloud-eliza-1-27b".
 *   VAST_RUNTIME       — "llama" (default) or "vllm".
 *   MILADY_VAST_MANIFEST — vLLM manifest name/path. Defaults to
 *                        eliza-1-2b.json when VAST_RUNTIME=vllm.
 *   PYWORKER_REPO      — git URL for the PyWorker source (defaults to the
 *                        elizaOS/cloud repo).
 *   PYWORKER_REF       — branch/tag/commit. **Pin a commit in production**;
 *                        defaults to "develop" only because that matches the
 *                        non-production default.
 *   MODEL_REPO         — HF repo id of the GGUF.
 *   MODEL_FILE         — GGUF filename inside that repo.
 *   MODEL_ALIAS        — `--alias` for llama-server (also the catalog id).
 *   DFLASH_DRAFTER_REPO / DFLASH_DRAFTER_FILE — optional drafter GGUF.
 *   LLAMA_SERVER_BIN   — compatible llama-server binary (default: llama-server).
 *   HF_TOKEN_SECRET    — pass-through HuggingFace token for gated repos.
 *
 * The on_start script lives in services/vast-pyworker/onstart.sh and is
 * inlined here at write time so the Vast template is fully self-contained
 * (Vast doesn't fetch additional files at start; everything happens inside
 * the on_start body).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VAST_API = "https://console.vast.ai";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VAST_PYWORKER_DIR = join(__dirname, "..", "..", "services", "vast-pyworker");
const MANIFEST_DIR = join(VAST_PYWORKER_DIR, "manifests");

interface TemplateConfig {
  name: string;
  // Docker image with `llama-server` on PATH, CUDA runtime, python3.
  image: string;
  // GiB of root disk requested per worker.
  disk: number;
  // Inline shell that runs on container start. Vast streams stdout/stderr.
  onstart: string;
  // Pass-through env vars for onstart.sh.
  env: Record<string, string>;
  // 8080 is llama-server's default; expose it for health checks.
  // Vast injects PUBLIC_IPADDR/VAST_TCP_PORT_8080 automatically.
  search_params: Record<string, never>;
  runtype: "args";
}

interface VastTemplate {
  id: number;
  name: string;
}

interface VastManifest {
  image?: string;
  min_disk_gb?: number;
  model?: string;
  model_repo?: string;
  model_alias?: string;
  served_model_name?: string;
  port?: number;
  vast_template_env?: Record<string, string>;
}

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value && value.trim().length > 0) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}`);
}

function optionalEnv(env: Record<string, string>, names: string[]): void {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) env[name] = value;
  }
}

function resolveManifestPath(manifest: string): string {
  if (manifest.startsWith("/")) return manifest;
  return join(MANIFEST_DIR, manifest);
}

function readVllmManifest(): { name: string; json: string; manifest: VastManifest } {
  const name = readEnv("MILADY_VAST_MANIFEST", "eliza-1-2b.json");
  const path = resolveManifestPath(name);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as VastManifest;
  return { name, json: JSON.stringify(manifest), manifest };
}

async function vastFetch<T>(
  apiKey: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${VAST_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Vast ${method} ${path} -> ${res.status}: ${text}`);
  }
  return text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
}

async function findTemplateByName(apiKey: string, name: string): Promise<VastTemplate | null> {
  const list = await vastFetch<{ templates?: VastTemplate[] }>(apiKey, "GET", "/api/v0/templates/");
  return list.templates?.find((t) => t.name === name) ?? null;
}

async function upsertTemplate(apiKey: string, config: TemplateConfig): Promise<VastTemplate> {
  const existing = await findTemplateByName(apiKey, config.name);
  if (existing) {
    console.log(`[vast] Updating template #${existing.id} (${config.name})`);
    await vastFetch(apiKey, "PUT", `/api/v0/templates/${existing.id}/`, config);
    return existing;
  }
  console.log(`[vast] Creating template ${config.name}`);
  return await vastFetch<VastTemplate>(apiKey, "POST", "/api/v0/templates/", config);
}

async function main(): Promise<void> {
  const apiKey = readEnv("VASTAI_API_KEY");
  const runtime = readEnv("VAST_RUNTIME", "llama").toLowerCase();
  if (runtime !== "llama" && runtime !== "vllm") {
    throw new Error(`VAST_RUNTIME must be "llama" or "vllm", got ${runtime}`);
  }
  const manifest = runtime === "vllm" ? readVllmManifest() : null;
  const onstartPath = join(
    VAST_PYWORKER_DIR,
    runtime === "vllm" ? "onstart-vllm.sh" : "onstart.sh",
  );
  const onstart = readFileSync(onstartPath, "utf8");

  const env: Record<string, string> = {
    PYWORKER_REPO: readEnv("PYWORKER_REPO", "https://github.com/elizaOS/cloud.git"),
    PYWORKER_REF: readEnv("PYWORKER_REF", "develop"),
  };

  if (runtime === "vllm") {
    env.MILADY_VAST_MANIFEST = manifest?.name ?? "eliza-1-2b.json";
    if (manifest) {
      env.MILADY_VAST_MANIFEST_JSON = manifest.json;
      for (const [key, value] of Object.entries(manifest.manifest.vast_template_env ?? {})) {
        if (value) env[key] = value;
      }
    }
    env.MODEL_REPO = readEnv(
      "MODEL_REPO",
      manifest?.manifest.model ?? manifest?.manifest.model_repo ?? "elizaos/eliza-1-2b",
    );
    env.MODEL_ALIAS = readEnv("MODEL_ALIAS", manifest?.manifest.model_alias ?? "vast/eliza-1-2b");
    if (manifest?.manifest.served_model_name) {
      env.SERVED_MODEL_NAME = readEnv("SERVED_MODEL_NAME", manifest.manifest.served_model_name);
    }
    env.PORT = readEnv("PORT", String(manifest?.manifest.port ?? 8000));
    optionalEnv(env, [
      "SERVED_MODEL_NAME",
      "TENSOR_PARALLEL_SIZE",
      "EXPERT_PARALLEL_SIZE",
      "MAX_MODEL_LEN",
      "GPU_MEMORY_UTILIZATION",
      "WEIGHT_QUANT",
      "KV_CACHE_DTYPE",
      "VLLM_ENABLE_TURBOQUANT",
      "VLLM_TURBOQUANT_PRESET",
      "DFLASH_MODEL",
      "MILADY_VLLM_DFLASH",
      "SPECULATIVE_CONFIG_JSON",
      "SPECULATIVE_TOKENS",
      "DRAFT_TENSOR_PARALLEL_SIZE",
      "DRAFT_MAX_MODEL_LEN",
      "COMPILATION_CONFIG_JSON",
      "ADDITIONAL_CONFIG_JSON",
      "VLLM_METAL_ADDITIONAL_CONFIG_JSON",
      "VLLM_ENABLE_METAL_TURBOQUANT",
      "VLLM_EXPERIMENTAL_QJL",
      "VLLM_QJL_BENCHMARK_GATE",
      "QJL_ADDITIONAL_CONFIG_JSON",
      "EXTRA_VLLM_ARGS",
    ]);
  } else {
    env.MODEL_REPO = readEnv(
      "MODEL_REPO",
      "elizaos/eliza-1-27b-fp8",
    );
    env.MODEL_FILE = readEnv("MODEL_FILE", "text/eliza-1-pro-27b-128k.gguf");
    env.MODEL_ALIAS = readEnv("MODEL_ALIAS", "vast/eliza-1-27b");
    env.LLAMA_CONTEXT = readEnv("LLAMA_CONTEXT", "32768");
    env.LLAMA_PARALLEL = readEnv("LLAMA_PARALLEL", "2");
    env.LLAMA_NGL = readEnv("LLAMA_NGL", "99");
    env.LLAMA_SERVER_PORT = readEnv("LLAMA_SERVER_PORT", "8080");
    env.LLAMA_SERVER_BIN = readEnv("LLAMA_SERVER_BIN", "llama-server");
    env.MODEL_DIR = readEnv("MODEL_DIR", "/workspace/models");
    optionalEnv(env, [
      "DFLASH_DRAFTER_REPO",
      "DFLASH_DRAFTER_FILE",
      "DFLASH_SPEC_TYPE",
      "LLAMA_DRAFT_NGL",
      "LLAMA_DRAFT_CONTEXT",
      "LLAMA_DRAFT_MIN",
      "LLAMA_DRAFT_MAX",
      "LLAMA_CACHE_TYPE_K",
      "LLAMA_CACHE_TYPE_V",
      "LLAMA_EXTRA_ARGS",
    ]);
  }

  const hfToken = process.env.HF_TOKEN_SECRET ?? process.env.HUGGING_FACE_HUB_TOKEN;
  if (hfToken && hfToken.trim().length > 0) {
    env.HUGGING_FACE_HUB_TOKEN = hfToken.trim();
  }

  const config: TemplateConfig = {
    name: readEnv(
      "VAST_TEMPLATE_NAME",
      runtime === "vllm" ? "eliza-cloud-eliza-1-vllm" : "eliza-cloud-eliza-1-27b",
    ),
    // Official llama.cpp CUDA server image for stock GGUF. DFlash/TurboQuant
    // deployments must set VAST_IMAGE to a compatible fork/runtime image.
    image: readEnv(
      "VAST_IMAGE",
      runtime === "vllm"
        ? (manifest?.manifest.image ?? "vllm/vllm-openai:v0.20.1")
        : "ghcr.io/ggml-org/llama.cpp:server-cuda",
    ),
    disk: Number(readEnv("VAST_DISK_GB", String(manifest?.manifest.min_disk_gb ?? 60))),
    onstart,
    env,
    search_params: {},
    runtype: "args",
  };

  const template = await upsertTemplate(apiKey, config);
  console.log(`[vast] Template ready: id=${template.id} name=${template.name}`);
  console.log(
    `[vast] Next: VAST_TEMPLATE_ID=${template.id} bun scripts/vast/provision-endpoint.ts`,
  );
}

main().catch((err: Error) => {
  console.error(`[vast] template upsert failed: ${err.message}`);
  process.exit(1);
});
