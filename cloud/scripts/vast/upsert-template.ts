/**
 * Idempotent Vast.ai template upsert for the Qwen3.6 27B NEO-CODE serving
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
 *   VAST_TEMPLATE_NAME — defaults to "eliza-cloud-qwen3.6-27b-neo-code".
 *   PYWORKER_REPO      — git URL for the PyWorker source (defaults to the
 *                        elizaOS/cloud repo).
 *   PYWORKER_REF       — branch/tag/commit. **Pin a commit in production**;
 *                        defaults to "develop" only because that matches the
 *                        non-production default.
 *   MODEL_REPO         — HF repo id of the GGUF.
 *   MODEL_FILE         — GGUF filename inside that repo.
 *   MODEL_ALIAS        — `--alias` for llama-server (also the catalog id).
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
const ONSTART_PATH = join(__dirname, "..", "..", "services", "vast-pyworker", "onstart.sh");

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

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value && value.trim().length > 0) return value.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${name}`);
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
  const list = await vastFetch<{ templates?: VastTemplate[] }>(
    apiKey,
    "GET",
    "/api/v0/templates/",
  );
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
  const onstart = readFileSync(ONSTART_PATH, "utf8");

  const env: Record<string, string> = {
    PYWORKER_REPO: readEnv("PYWORKER_REPO", "https://github.com/elizaOS/cloud.git"),
    PYWORKER_REF: readEnv("PYWORKER_REF", "develop"),
    MODEL_REPO: readEnv(
      "MODEL_REPO",
      "DavidAU/Qwen3.6-27B-Heretic-Uncensored-FINETUNE-NEO-CODE-Di-IMatrix-MAX-GGUF",
    ),
    MODEL_FILE: readEnv("MODEL_FILE", "Qwen3.6-27B-NEO-CODE-HERE-2T-OT-Q6_K.gguf"),
    MODEL_ALIAS: readEnv("MODEL_ALIAS", "vast/qwen3.6-27b-neo-code"),
    LLAMA_CONTEXT: readEnv("LLAMA_CONTEXT", "32768"),
    LLAMA_PARALLEL: readEnv("LLAMA_PARALLEL", "2"),
    LLAMA_NGL: readEnv("LLAMA_NGL", "99"),
    MODEL_DIR: readEnv("MODEL_DIR", "/workspace/models"),
  };

  const hfToken = process.env.HF_TOKEN_SECRET ?? process.env.HUGGING_FACE_HUB_TOKEN;
  if (hfToken && hfToken.trim().length > 0) {
    env.HUGGING_FACE_HUB_TOKEN = hfToken.trim();
  }

  const config: TemplateConfig = {
    name: readEnv("VAST_TEMPLATE_NAME", "eliza-cloud-qwen3.6-27b-neo-code"),
    // Official llama.cpp CUDA server image — stable enough that we pin to
    // `server-cuda` (a moving tag); upgrade by bumping `MODEL_FILE`'s repo
    // and re-running this script. To pin harder, set `:server-cuda-master-<sha>`.
    image: readEnv("VAST_IMAGE", "ghcr.io/ggml-org/llama.cpp:server-cuda"),
    disk: Number(readEnv("VAST_DISK_GB", "60")),
    onstart,
    env,
    search_params: {},
    runtype: "args",
  };

  const template = await upsertTemplate(apiKey, config);
  console.log(`[vast] Template ready: id=${template.id} name=${template.name}`);
  console.log(`[vast] Next: VAST_TEMPLATE_ID=${template.id} bun scripts/vast/provision-endpoint.ts`);
}

main().catch((err: Error) => {
  console.error(`[vast] template upsert failed: ${err.message}`);
  process.exit(1);
});
