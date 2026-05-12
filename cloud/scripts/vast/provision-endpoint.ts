/**
 * Idempotent Vast.ai Serverless endpoint provisioning.
 *
 * Run once per environment to create or update the endpoint that hosts the
 * Eliza-1 27B Q6_K GGUF on RTX 5090 via llama.cpp. Vast manages the
 * autoscaler, queue, and load balancer; this script only declares the desired
 * endpoint + workergroup config.
 *
 * Required env:
 *   VASTAI_API_KEY        — vast CLI key (starts with `vastai_`)
 *   VAST_TEMPLATE_ID      — id of the serverless-compatible template that
 *                           launches llama-server + PyWorker (see
 *                           services/vast-pyworker/README.md and
 *                           scripts/vast/upsert-template.ts)
 *
 * Optional env:
 *   VAST_ENDPOINT_NAME    — defaults to "eliza-cloud-eliza-1-27b"
 *   VAST_MIN_WORKERS      — defaults to 1
 *   VAST_MAX_WORKERS      — defaults to 8
 *   VAST_TARGET_UTIL      — defaults to 0.9
 *
 * The vast.ai REST host is https://console.vast.ai. Endpoint lifecycle is
 * available under /api/v0/endptjobs/ (legacy autoscaler) and /api/v0/serverless/
 * (Serverless v2). This script targets v2.
 */

const VAST_API = "https://console.vast.ai";

interface EndpointConfig {
  name: string;
  template_id: number;
  min_workers: number;
  max_workers: number;
  min_load: number;
  cold_mult: number;
  target_util: number;
  inactivity_timeout: number;
  max_queue_time: number;
  target_queue_time: number;
  search_params: SearchParams;
}

interface SearchParams {
  gpu_name: string[];
  gpu_ram_min: number;
  disk_space_min: number;
  duration_min: number;
  rentable: boolean;
  verified: boolean;
  reliability_min: number;
  rental_type: "on_demand" | "reserved" | "interruptible";
}

interface VastEndpoint {
  id: number;
  name: string;
}

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value && value.trim().length > 0) {
    return value.trim();
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Missing required env var: ${name}`);
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Env ${name}=${raw} is not a valid number`);
  }
  return parsed;
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

async function findEndpointByName(apiKey: string, name: string): Promise<VastEndpoint | null> {
  const list = await vastFetch<{ endpoints?: VastEndpoint[] }>(
    apiKey,
    "GET",
    "/api/v0/serverless/endpoints",
  );
  return list.endpoints?.find((e) => e.name === name) ?? null;
}

async function upsertEndpoint(apiKey: string, config: EndpointConfig): Promise<VastEndpoint> {
  const existing = await findEndpointByName(apiKey, config.name);
  if (existing) {
    console.log(`[vast] Updating endpoint #${existing.id} (${config.name})`);
    await vastFetch(apiKey, "PUT", `/api/v0/serverless/endpoints/${existing.id}`, config);
    return existing;
  }
  console.log(`[vast] Creating endpoint ${config.name}`);
  return await vastFetch<VastEndpoint>(apiKey, "POST", "/api/v0/serverless/endpoints", config);
}

async function main(): Promise<void> {
  const apiKey = readEnv("VASTAI_API_KEY");
  const templateId = Number(readEnv("VAST_TEMPLATE_ID"));
  if (!Number.isInteger(templateId) || templateId <= 0) {
    throw new Error(`VAST_TEMPLATE_ID must be a positive integer, got ${templateId}`);
  }

  const config: EndpointConfig = {
    name: readEnv("VAST_ENDPOINT_NAME", "eliza-cloud-eliza-1-27b"),
    template_id: templateId,
    min_workers: readNumber("VAST_MIN_WORKERS", 1),
    max_workers: readNumber("VAST_MAX_WORKERS", 8),
    min_load: readNumber("VAST_MIN_LOAD", 1),
    cold_mult: readNumber("VAST_COLD_MULT", 3),
    target_util: readNumber("VAST_TARGET_UTIL", 0.9),
    inactivity_timeout: readNumber("VAST_INACTIVITY_TIMEOUT", -1),
    max_queue_time: readNumber("VAST_MAX_QUEUE_TIME", 60),
    target_queue_time: readNumber("VAST_TARGET_QUEUE_TIME", 5),
    search_params: {
      gpu_name: ["RTX_5090"],
      // RTX 5090 has 32 GB VRAM. Q6_K is 22.4 GB; min 25 GB ensures KV-cache
      // headroom for at least 4096-token context with --parallel 2.
      gpu_ram_min: readNumber("VAST_GPU_RAM_MIN_MB", 25000),
      // Q6_K GGUF is 22.4 GB; require 50 GB to leave room for HF cache,
      // staging, and a second quant variant if we hot-swap.
      disk_space_min: readNumber("VAST_DISK_MIN_GB", 50),
      duration_min: readNumber("VAST_DURATION_MIN_SECONDS", 7 * 24 * 3600),
      rentable: true,
      verified: true,
      reliability_min: readNumber("VAST_RELIABILITY_MIN", 0.9),
      rental_type: "on_demand",
    },
  };

  const endpoint = await upsertEndpoint(apiKey, config);
  console.log(`[vast] Endpoint ready: id=${endpoint.id} name=${endpoint.name}`);
  console.log(
    "[vast] Next: set VAST_API_KEY + VAST_BASE_URL on the cloud Worker",
    "(wrangler secret put VAST_API_KEY / VAST_BASE_URL).",
  );
}

main().catch((err: Error) => {
  console.error(`[vast] provision failed: ${err.message}`);
  process.exit(1);
});
