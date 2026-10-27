/**
 * Deployed latency harness for subscription plan admission. It measures what
 * Cloud's plan admission adds to the existing inference and Maps requests of
 * a real deployment, under five conditions:
 *
 *   normal          an account with an admitted plan and tokens available
 *   cache-miss      the first request of each fresh key (cold auth and plan caches)
 *   exhausted       an account whose plan bucket or period allowance is used up
 *   expired         an account whose plan window has ended
 *   billing-outage  a deployment whose billing store an operator has made unavailable
 *
 * A person prepares one account per condition and names, in the config file,
 * the environment variables that hold its keys. This harness creates no
 * account, key, plan, grant or outage, and it never prints a key.
 *
 * For each condition and service it sends sequential requests and records the
 * client time to response headers, the status, the classified outcome and the
 * Worker's Server-Timing `gateway_auth` and `gateway_preforward` when present.
 * An unauthenticated `GET /api/v1/subscription/entitlement-keys` baseline
 * measures the network round trip, so the report states the admission-added
 * p50/p95 as the condition minus the baseline. Each condition declares its
 * expected outcomes; every mismatch is counted and reported, never dropped.
 *
 * Normal-condition requests are real: a one-token completion and a geocode
 * lookup are billed or counted against the prepared account. The run refuses
 * to start without --confirm-real-requests. Local, in-process numbers for the
 * same conditions come from plan-request-limit-latency.ts.
 *
 * Run:    node packages/cloud/scripts/plan-admission-deployed-latency.ts \
 *           --config <file.json> --confirm-real-requests
 * Output: test-results/plan-admission-deployed-latency/results.json
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { readServiceLimit } from "../sdk/src/subscription-entitlement.ts";

export const CONDITIONS = [
  "normal",
  "cache-miss",
  "exhausted",
  "expired",
  "billing-outage",
] as const;
export type Condition = (typeof CONDITIONS)[number];
export const SERVICES = ["inference", "maps"] as const;
export type Service = (typeof SERVICES)[number];
export const OUTCOMES = [
  "admitted",
  "rate-limited",
  "allowance-exhausted",
  "subscription-required",
  "billing-refused",
  "cache-warming",
  "unauthorized",
  "unavailable",
  "unexpected",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface ConditionConfig {
  /** Environment variable holding the condition's key. */
  keyEnv?: string;
  /** Environment variable holding comma-separated fresh keys, each used for one request (cache-miss). */
  keysEnv?: string;
  /** API origin for this condition when it differs (an outage deployment). */
  apiBase?: string;
  /** Outcomes this condition must produce, per service. */
  expect: Record<Service, Outcome[]>;
}
export interface DeployedLatencyConfig {
  apiBase: string;
  iterations: number;
  warmup: number;
  services: Service[];
  inference: { model: string };
  maps: { query: string };
  conditions: Partial<Record<Condition, ConditionConfig>>;
}

const DEFAULT_EXPECT: Record<Condition, Outcome[]> = {
  normal: ["admitted"],
  "cache-miss": ["admitted"],
  exhausted: ["rate-limited", "allowance-exhausted"],
  expired: ["subscription-required", "billing-refused"],
  "billing-outage": ["admitted", "cache-warming", "unavailable"],
};

function fail(message: string): never {
  throw new Error(`Invalid deployed latency config: ${message}`);
}
function exactOrigin(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} is not a URL`);
  }
  if (url.protocol !== "https:" || url.origin !== value)
    fail(`${label} must be an exact https origin`);
  return value;
}
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

/** Validates a config file. Keys are referenced by environment variable name only. */
export function parseDeployedLatencyConfig(
  value: unknown,
): DeployedLatencyConfig {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || Array.isArray(row))
    fail("expected an object");
  const apiBase = exactOrigin(row.apiBase, "apiBase");
  const iterations = row.iterations ?? 50;
  const warmup = row.warmup ?? 3;
  if (
    !Number.isSafeInteger(iterations) ||
    (iterations as number) < 5 ||
    (iterations as number) > 2000
  )
    fail("iterations must be an integer from 5 to 2000");
  if (
    !Number.isSafeInteger(warmup) ||
    (warmup as number) < 0 ||
    (warmup as number) > 50
  )
    fail("warmup must be an integer from 0 to 50");
  const services = (row.services ?? [...SERVICES]) as Service[];
  if (
    !Array.isArray(services) ||
    !services.length ||
    services.some((service) => !SERVICES.includes(service))
  )
    fail("services must list inference and/or maps");
  const inference = row.inference as { model?: unknown } | undefined;
  if (
    services.includes("inference") &&
    (typeof inference?.model !== "string" ||
      !/^[A-Za-z0-9._:/-]{1,128}$/.test(inference.model))
  )
    fail("inference.model is required for inference");
  const maps = row.maps as { query?: unknown } | undefined;
  if (
    services.includes("maps") &&
    (typeof maps?.query !== "string" ||
      !maps.query.trim() ||
      maps.query.length > 300)
  )
    fail("maps.query is required for maps");
  const input = row.conditions as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object") fail("conditions are required");
  const conditions: Partial<Record<Condition, ConditionConfig>> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (!CONDITIONS.includes(name as Condition))
      fail(`unknown condition ${name}`);
    const condition = name as Condition;
    const item = raw as Record<string, unknown>;
    const keyEnv = item?.keyEnv,
      keysEnv = item?.keysEnv;
    if (
      condition === "cache-miss"
        ? typeof keysEnv !== "string" || !ENV_NAME.test(keysEnv)
        : typeof keyEnv !== "string" || !ENV_NAME.test(keyEnv)
    )
      fail(
        `${condition} needs ${condition === "cache-miss" ? "keysEnv" : "keyEnv"} (an environment variable name)`,
      );
    const expectInput = (item.expect ?? {}) as Record<string, unknown>;
    const expect = {} as Record<Service, Outcome[]>;
    for (const service of SERVICES) {
      const listed = expectInput[service] ?? DEFAULT_EXPECT[condition];
      if (
        !Array.isArray(listed) ||
        !listed.length ||
        listed.some((outcome) => !OUTCOMES.includes(outcome))
      )
        fail(`${condition}.expect.${service} must list known outcomes`);
      expect[service] = listed as Outcome[];
    }
    conditions[condition] = {
      ...(typeof keyEnv === "string" ? { keyEnv } : {}),
      ...(typeof keysEnv === "string" ? { keysEnv } : {}),
      ...(item.apiBase === undefined
        ? {}
        : { apiBase: exactOrigin(item.apiBase, `${condition}.apiBase`) }),
      expect,
    };
  }
  if (!Object.keys(conditions).length)
    fail("at least one condition is required");
  return {
    apiBase,
    iterations: iterations as number,
    warmup: warmup as number,
    services,
    inference: { model: (inference?.model as string) ?? "" },
    maps: { query: (maps?.query as string)?.trim() ?? "" },
    conditions,
  };
}

/** Durations of named Server-Timing metrics, e.g. `gateway_preforward;dur=12.5`. */
export function parseServerTiming(
  header: string | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!header) return out;
  for (const entry of header.split(",")) {
    const [name, ...params] = entry.trim().split(";");
    const duration = params
      .map((param) => param.trim().match(/^dur=([0-9]+(?:\.[0-9]+)?)$/))
      .find(Boolean);
    if (name && /^[A-Za-z0-9_-]{1,64}$/.test(name) && duration)
      out[name] = Number(duration[1]);
  }
  return out;
}

/** Classifies one response by status and its bounded JSON body. */
export function classifyResponse(
  status: number,
  body: unknown,
  retryAfter: string | null,
): Outcome {
  if (status >= 200 && status < 300) return "admitted";
  const error = (body as { error?: { code?: unknown } } | null)?.error;
  if (
    status === 503 &&
    typeof error === "object" &&
    error?.code === "rate_limit_cache_warming"
  )
    return "cache-warming";
  const limit = readServiceLimit({ status, data: body, retryAfter });
  if (limit) return limit.kind;
  if (status === 401 || status === 403) return "unauthorized";
  if (status >= 500) return "unavailable";
  return "unexpected";
}

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  mean: number;
}
export function summarize(samples: number[]): Summary | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

export interface Sample {
  status: number;
  outcome: Outcome;
  clientMs: number;
  serverTiming: Record<string, number>;
}
export interface SeriesReport {
  condition: Condition | "baseline";
  service: Service | "network";
  expected: Outcome[];
  outcomes: Partial<Record<Outcome, number>>;
  statuses: Record<string, number>;
  mismatches: number;
  client: Summary | null;
  gatewayAuth: Summary | null;
  gatewayPreforward: Summary | null;
  /** Client p50/p95 minus the network baseline: what admission and the route add. */
  addedOverBaseline: { p50: number; p95: number } | null;
}
export function seriesReport(
  condition: SeriesReport["condition"],
  service: SeriesReport["service"],
  expected: Outcome[],
  samples: Sample[],
  baseline: Summary | null,
): SeriesReport {
  const outcomes: Partial<Record<Outcome, number>> = {};
  const statuses: Record<string, number> = {};
  for (const sample of samples) {
    outcomes[sample.outcome] = (outcomes[sample.outcome] ?? 0) + 1;
    statuses[String(sample.status)] =
      (statuses[String(sample.status)] ?? 0) + 1;
  }
  const client = summarize(samples.map((sample) => sample.clientMs));
  const timing = (name: string) =>
    summarize(
      samples
        .map((sample) => sample.serverTiming[name])
        .filter((value): value is number => typeof value === "number"),
    );
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    condition,
    service,
    expected,
    outcomes,
    statuses,
    mismatches: samples.filter((sample) => !expected.includes(sample.outcome))
      .length,
    client,
    gatewayAuth: timing("gateway_auth"),
    gatewayPreforward: timing("gateway_preforward"),
    addedOverBaseline:
      client && baseline
        ? {
            p50: round(client.p50 - baseline.p50),
            p95: round(client.p95 - baseline.p95),
          }
        : null,
  };
}

const BODY_LIMIT = 64 * 1024;
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_LIMIT) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export interface RequestPlan {
  url: string;
  init: RequestInit;
}
/** The existing route a client uses, with the smallest real request. */
export function requestPlan(
  config: DeployedLatencyConfig,
  service: Service,
  apiBase: string,
  key: string,
): RequestPlan {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    "Idempotency-Key": randomUUID(),
  };
  if (service === "inference")
    return {
      url: `${apiBase}/api/v1/chat/completions`,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.inference.model,
          messages: [{ role: "user", content: "Reply with one word." }],
          max_tokens: 1,
          stream: false,
        }),
      },
    };
  return {
    url: `${apiBase}/api/v1/maps/geocode`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({ query: config.maps.query, limit: 1 }),
    },
  };
}

/** Client deadline of one measured request. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Sends one request and classifies it. A request that gets no response (a
 * timeout, a reset connection or a refused redirect) is recorded as status 0,
 * `unavailable`, with the time the client waited: during an outage that wait
 * is the measurement, and one lost request never discards the whole run.
 */
export async function measure(
  plan: RequestPlan,
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => performance.now(),
): Promise<Sample> {
  const started = now();
  let response: Response;
  try {
    response = await fetchImpl(plan.url, {
      ...plan.init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return {
      status: 0,
      outcome: "unavailable",
      clientMs: Math.round((now() - started) * 1000) / 1000,
      serverTiming: {},
    };
  }
  const clientMs = now() - started;
  // A body cut off after the headers still has a status; it is classified without the body.
  const body = await boundedJson(response).catch(() => null);
  return {
    status: response.status,
    outcome: classifyResponse(
      response.status,
      body,
      response.headers.get("retry-after"),
    ),
    clientMs: Math.round(clientMs * 1000) / 1000,
    serverTiming: parseServerTiming(response.headers.get("server-timing")),
  };
}

export interface DeployedLatencyResult {
  schema: 1;
  generatedAt: string;
  apiBase: string;
  iterations: number;
  warmup: number;
  baseline: SeriesReport;
  series: SeriesReport[];
  /** True when every sample matched its condition's expected outcomes. */
  expectationsMet: boolean;
}

/** Runs every configured condition. `env` supplies keys; nothing secret is returned. */
export async function runDeployedLatency(
  config: DeployedLatencyConfig,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => performance.now(),
): Promise<DeployedLatencyResult> {
  const baselineSamples: Sample[] = [];
  const baselinePlan: RequestPlan = {
    url: `${config.apiBase}/api/v1/subscription/entitlement-keys`,
    init: { method: "GET", headers: { Accept: "application/json" } },
  };
  for (let i = 0; i < config.warmup; i++)
    await measure(baselinePlan, fetchImpl, now);
  for (let i = 0; i < config.iterations; i++)
    baselineSamples.push(await measure(baselinePlan, fetchImpl, now));
  const baseline = seriesReport(
    "baseline",
    "network",
    ["admitted"],
    baselineSamples,
    null,
  );
  const series: SeriesReport[] = [];
  for (const condition of CONDITIONS) {
    const settings = config.conditions[condition];
    if (!settings) continue;
    const apiBase = settings.apiBase ?? config.apiBase;
    const keys =
      condition === "cache-miss"
        ? (env[settings.keysEnv as string] ?? "")
            .split(",")
            .map((key) => key.trim())
            .filter(Boolean)
        : [env[settings.keyEnv as string] ?? ""].filter(Boolean);
    if (!keys.length)
      throw new Error(
        `${condition}: set ${condition === "cache-miss" ? settings.keysEnv : settings.keyEnv}`,
      );
    for (const service of config.services) {
      const samples: Sample[] = [];
      if (condition === "cache-miss") {
        // Each fresh key is used exactly once, so every measured request is a first request.
        const needed = config.iterations * config.services.length;
        if (keys.length < needed)
          throw new Error(
            `cache-miss needs ${needed} fresh keys in ${settings.keysEnv}; ${keys.length} were set`,
          );
        const offset = config.services.indexOf(service) * config.iterations;
        for (let i = 0; i < config.iterations; i++)
          samples.push(
            await measure(
              requestPlan(config, service, apiBase, keys[offset + i]),
              fetchImpl,
              now,
            ),
          );
      } else {
        for (let i = 0; i < config.warmup; i++)
          await measure(
            requestPlan(config, service, apiBase, keys[0]),
            fetchImpl,
            now,
          );
        for (let i = 0; i < config.iterations; i++)
          samples.push(
            await measure(
              requestPlan(config, service, apiBase, keys[0]),
              fetchImpl,
              now,
            ),
          );
      }
      series.push(
        seriesReport(
          condition,
          service,
          settings.expect[service],
          samples,
          baseline.client,
        ),
      );
    }
  }
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    apiBase: config.apiBase,
    iterations: config.iterations,
    warmup: config.warmup,
    baseline,
    series,
    expectationsMet:
      baseline.mismatches === 0 && series.every((row) => row.mismatches === 0),
  };
}

async function main(argv: string[]): Promise<void> {
  const configIndex = argv.indexOf("--config");
  const file = configIndex >= 0 ? argv[configIndex + 1] : undefined;
  if (!file)
    throw new Error("Usage: --config <file.json> --confirm-real-requests");
  if (!argv.includes("--confirm-real-requests"))
    throw new Error(
      "Normal-condition requests are real and billed or counted. Pass --confirm-real-requests to run.",
    );
  const config = parseDeployedLatencyConfig(
    JSON.parse(await readFile(path.resolve(file), "utf8")),
  );
  const result = await runDeployedLatency(config, process.env);
  const output = testOutputPath(
    "plan-admission-deployed-latency",
    "results.json",
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  for (const row of [result.baseline, ...result.series])
    console.log(
      `${row.condition.padEnd(14)} ${row.service.padEnd(9)} p50=${row.client?.p50 ?? "-"}ms p95=${row.client?.p95 ?? "-"}ms added p50=${row.addedOverBaseline?.p50 ?? "-"}ms p95=${row.addedOverBaseline?.p95 ?? "-"}ms mismatches=${row.mismatches}`,
    );
  console.log(`Wrote ${output}`);
  if (!result.expectationsMet) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await main(process.argv.slice(2));
