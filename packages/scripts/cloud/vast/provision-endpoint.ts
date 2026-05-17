/**
 * Manifest-driven Vast.ai Serverless endpoint + workergroup provisioning.
 *
 * Current Vast Serverless separates:
 *   - endpoint jobs: /api/v0/endptjobs/
 *   - workergroups: /api/v0/workergroups/
 *
 * The old script targeted a legacy /serverless/endpoints shape and hardcoded a
 * single RTX 5090 class. This version reads the selected Eliza serve manifest
 * so each model tier provisions the right worker image, GPU count, VRAM, disk,
 * network, and autoscaling policy.
 */

import {
  manifestGpuRamGb,
  manifestSearchParamsToQuery,
  readVastManifest,
  type VastServeManifest,
} from "./manifest";

const VAST_API = "https://console.vast.ai";

export interface EndpointJobPayload {
  endpoint_name: string;
  min_load: number;
  target_util: number;
  cold_mult: number;
  cold_workers: number;
  max_workers: number;
}

export interface WorkergroupPayload {
  endpoint_name?: string;
  endpoint_id?: number;
  template_id: number;
  gpu_ram: number;
  search_params?: string;
  launch_args?: string;
}

interface VastCreateResult {
  success?: boolean;
  result?: number;
  error?: string;
  msg?: string;
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

function readPositiveInt(name: string): number {
  const parsed = Number(readEnv(name));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${parsed}`);
  }
  return parsed;
}

export function buildEndpointJobPayload(manifest: VastServeManifest): EndpointJobPayload {
  const alias = manifest.model_alias?.replace(/^vast\//, "") ?? "eliza-1";
  return {
    endpoint_name: readEnv("VAST_ENDPOINT_NAME", `eliza-cloud-${alias}`),
    min_load: readNumber("VAST_MIN_LOAD", 1),
    target_util: readNumber("VAST_TARGET_UTIL", 0.85),
    cold_mult: readNumber("VAST_COLD_MULT", 2.5),
    cold_workers: readNumber("VAST_COLD_WORKERS", 1),
    max_workers: readNumber("VAST_MAX_WORKERS", 8),
  };
}

export function buildWorkergroupPayload(
  templateId: number,
  endpoint: EndpointJobPayload,
  manifest: VastServeManifest,
  endpointId?: number,
): WorkergroupPayload {
  const payload: WorkergroupPayload = {
    template_id: templateId,
    gpu_ram: readNumber("VAST_GPU_RAM_GB", manifestGpuRamGb(manifest)),
    search_params: readEnv("VAST_SEARCH_PARAMS", manifestSearchParamsToQuery(manifest)),
  };
  if (endpointId) {
    payload.endpoint_id = endpointId;
  } else {
    payload.endpoint_name = endpoint.endpoint_name;
  }

  const launchArgs = process.env.VAST_LAUNCH_ARGS?.trim();
  if (launchArgs) payload.launch_args = launchArgs;
  return payload;
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

async function createEndpointJob(
  apiKey: string,
  payload: EndpointJobPayload,
): Promise<number | null> {
  const result = await vastFetch<VastCreateResult>(apiKey, "POST", "/api/v0/endptjobs/", payload);
  if (result.success === false) {
    throw new Error(`Vast endpoint create failed: ${result.error ?? "error"} ${result.msg ?? ""}`);
  }
  return typeof result.result === "number" ? result.result : null;
}

async function createWorkergroup(
  apiKey: string,
  payload: WorkergroupPayload,
): Promise<number | null> {
  const result = await vastFetch<VastCreateResult>(
    apiKey,
    "POST",
    "/api/v0/workergroups/",
    payload,
  );
  if (result.success === false) {
    throw new Error(
      `Vast workergroup create failed: ${result.error ?? "error"} ${result.msg ?? ""}`,
    );
  }
  return typeof result.result === "number" ? result.result : null;
}

function printDryRun(endpoint: EndpointJobPayload, workergroup: WorkergroupPayload): void {
  console.log(
    JSON.stringify(
      {
        endpoint,
        workergroup,
        env: {
          VAST_BASE_URL: `https://openai.vast.ai/${endpoint.endpoint_name}`,
        },
      },
      null,
      2,
    ),
  );
}

export async function main(): Promise<void> {
  const apiKey = readEnv("VASTAI_API_KEY");
  const templateId = readPositiveInt("VAST_TEMPLATE_ID");
  const manifest = readVastManifest(readEnv("ELIZA_VAST_MANIFEST", "eliza-1-2b.json")).manifest;
  const endpoint = buildEndpointJobPayload(manifest);
  const explicitEndpointId = process.env.VAST_ENDPOINT_ID
    ? readPositiveInt("VAST_ENDPOINT_ID")
    : undefined;
  const workergroup = buildWorkergroupPayload(templateId, endpoint, manifest, explicitEndpointId);

  if (process.env.VAST_DRY_RUN === "1" || process.env.VAST_DRY_RUN === "true") {
    printDryRun(endpoint, workergroup);
    return;
  }

  const endpointId = explicitEndpointId ?? (await createEndpointJob(apiKey, endpoint));
  if (endpointId && !workergroup.endpoint_id) {
    delete workergroup.endpoint_name;
    workergroup.endpoint_id = endpointId;
  }
  const workergroupId = await createWorkergroup(apiKey, workergroup);

  console.log(
    `[vast] Endpoint ready: name=${endpoint.endpoint_name} id=${endpointId ?? "unknown"}`,
  );
  console.log(`[vast] Workergroup ready: id=${workergroupId ?? "unknown"}`);
  console.log(`[vast] Worker base URL: https://openai.vast.ai/${endpoint.endpoint_name}`);
  console.log(
    `[vast] Configure cloud: VAST_BASE_URL_${endpoint.endpoint_name
      .replace(/^eliza-cloud-/, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .toUpperCase()}=https://openai.vast.ai/${endpoint.endpoint_name}`,
  );
}

if (import.meta.main) {
  main().catch((err: Error) => {
    console.error(`[vast] provision failed: ${err.message}`);
    process.exit(1);
  });
}
