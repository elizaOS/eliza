/** Protected, read-only catalog probe. Provider logs never leave memory. */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const bindings = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PLUS_MONTHLY_PRICE_ID",
  "STRIPE_PLUS_PRODUCT_ID",
  "STRIPE_PRO_MONTHLY_PRICE_ID",
  "STRIPE_PRO_PRODUCT_ID",
];
const codes = new Set([
  "SUBSCRIPTION_CATALOG_BINDING_INVALID",
  "SUBSCRIPTION_CATALOG_STRIPE_KEY_INVALID",
  "SUBSCRIPTION_CATALOG_DEPLOYMENT_MODE_MISMATCH",
  "SUBSCRIPTION_CATALOG_DUPLICATE_PRICE_BINDING",
  "SUBSCRIPTION_CATALOG_DUPLICATE_PRODUCT_BINDING",
  "SUBSCRIPTION_CATALOG_PROVIDER_DRIFT",
  "SUBSCRIPTION_CATALOG_PROVIDER_UNAVAILABLE",
  "SUBSCRIPTION_CATALOG_UNAVAILABLE",
]);

export function appendTailOutput(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) + chunk.length > 1048576)
    throw new Error("catalog_tail_limit");
  return current + chunk.toString();
}

export function catalogCodes(raw: string, expectedUrl: string): string[] {
  const found = new Set<string>();
  // Wrangler 4.116 JSON output uses four-space indentation, one object per event.
  for (const block of raw.split(/(?<=\n\})\s*(?=\{)/)) {
    let event = null;
    try {
      event = JSON.parse(block);
    } catch {
      continue;
    }
    if (
      event?.event?.request?.method !== "GET" ||
      event?.event?.request?.url !== expectedUrl
    )
      continue;
    if (!Array.isArray(event.logs)) continue;
    for (const log of event.logs) {
      const message = JSON.stringify(log?.message);
      if (!message?.includes("[SubscriptionPlansAPI] Catalog unavailable"))
        continue;
      for (const code of codes)
        if (new RegExp(`\\b${code}\\b`).test(message)) found.add(code);
    }
  }
  return [...found].sort();
}

if (import.meta.main) {
  let tail: ReturnType<typeof spawn> | undefined;
  try {
    const environment = process.env.ELIZA_OPERATOR_ENVIRONMENT;
    if (environment !== "staging" && environment !== "production")
      throw new Error();
    if (
      environment === "production" &&
      process.env.GITHUB_REF !== "refs/heads/main"
    )
      throw new Error();
    const childEnv = {
      ...process.env,
      WRANGLER_WRITE_LOGS: "false",
      WRANGLER_SEND_METRICS: "false",
    };
    const options = { cwd: "packages/cloud/api", env: childEnv };
    const entries: unknown = JSON.parse(
      execFileSync(
        "bunx",
        [
          "wrangler@4.116.0",
          "secret",
          "list",
          "--env",
          environment,
          "--format",
          "json",
        ],
        {
          ...options,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60000,
        },
      ),
    );
    if (
      !Array.isArray(entries) ||
      entries.some((entry) => typeof entry?.name !== "string")
    )
      throw new Error();
    const names = new Set(entries.map((entry) => entry.name));
    console.log(
      JSON.stringify({
        workerBindings: Object.fromEntries(
          bindings.map((name) => [name, names.has(name)]),
        ),
      }),
    );
    const url = `https://${environment === "production" ? "api" : "api-staging"}.eliza.app/api/v1/subscriptions/plans`;
    const nonce = randomUUID();
    tail = spawn(
      "bunx",
      [
        "wrangler@4.116.0",
        "tail",
        "--env",
        environment,
        "--format",
        "json",
        "--method",
        "GET",
        "--header",
        `x-eliza-catalog-diagnostic:${nonce}`,
      ],
      { ...options, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      exceeded = false,
      failed = false;
    tail.on("error", () => {
      failed = true;
    });
    tail.stdout?.on("data", (chunk) => {
      if (exceeded) return;
      try {
        output = appendTailOutput(output, chunk);
      } catch {
        output = "";
        exceeded = true;
        tail?.kill("SIGTERM");
      }
    });
    tail.stderr?.resume(); // Never forward or persist provider errors.
    await delay(10000);
    if (failed || tail.exitCode !== null) throw new Error();
    const response = await fetch(url, {
      headers: {
        "x-eliza-catalog-diagnostic": nonce,
        "User-Agent": "Mozilla/5.0 ElizaCatalogDiagnostic",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    await delay(10000);
    if (failed || exceeded) throw new Error();
    const observedCodes = catalogCodes(output, url);
    output = "";
    console.log(
      JSON.stringify({
        httpStatus: response.status,
        catalogErrorCodes: observedCodes,
        capturedCatalogError: observedCodes.length > 0,
      }),
    );
    if (response.status !== 200 && observedCodes.length === 0)
      process.exitCode = 1;
  } catch {
    console.error("subscription_catalog_diagnostic_failed");
    process.exitCode = 1;
  } finally {
    if (tail && tail.exitCode === null) {
      tail.kill("SIGTERM");
      await delay(1000);
      if (tail.exitCode === null) tail.kill("SIGKILL");
    }
  }
}
