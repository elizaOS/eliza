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

const checkoutPhases = new Set([
  "authorization",
  "request_validation",
  "reconciliation",
  "response",
]);
const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ApiError",
  "ElizaError",
  "ZodError",
  "DrizzleQueryError",
  "SubscriptionCatalogError",
  "error",
  "DatabaseError",
  "PostgresError",
  "InferencePolicyFenceError",
  "UnmanagedWriteTransactionError",
  "MobileAppAuthProtocolError",
  "StripeAPIError",
  "StripeConnectionError",
  "StripeAuthenticationError",
  "StripePermissionError",
  "StripeRateLimitError",
  "StripeInvalidRequestError",
]);
const errorCodes = new Set([
  "SUBSCRIPTION_CHECKOUT_UNAVAILABLE",
  "SUBSCRIPTION_CHECKOUT_REJECTED",
  "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT",
  "SUBSCRIPTION_RENEWAL_UNAVAILABLE",
  "ORGANIZATION_POLICY_UNAVAILABLE",
  "SUBSCRIPTION_AUTHORITY_CONFLICT",
  "SUBSCRIPTION_AUTHORITY_TENANT_NOT_FOUND",
  "SUBSCRIPTION_ALLOWANCE_CONFLICT",
  "SUBSCRIPTION_ALLOWANCE_NOT_FOUND",
  "SUBSCRIPTION_ENTITLEMENT_CONFLICT",
  "SUBSCRIPTION_ENTITLEMENT_SOURCE_NOT_FOUND",
  "SUBSCRIPTION_ENTITLEMENT_TENANT_NOT_FOUND",
  "PRIMARY_DATABASE_CLOCK_UNAVAILABLE",
  "SUBSCRIPTION_ORGANIZATION_SOURCE_UNAVAILABLE",
  "SUBSCRIPTION_CANCELLATION_REOBSERVE",
  "SUBSCRIPTION_RENEWAL_AUTHORITY_CONFLICT",
  "SUBSCRIPTION_RENEWAL_DETAILS_CONFLICT",
  "SUBSCRIPTION_SETTLEMENT_DETAILS_CONFLICT",
  "SUBSCRIPTION_CATALOG_REVISION_NOT_FOUND",
  "SUBSCRIPTION_CATALOG_STRIPE_KEY_INVALID",
  "SUBSCRIPTION_CATALOG_DEPLOYMENT_MODE_MISMATCH",
  "SUBSCRIPTION_CATALOG_BINDING_INVALID",

  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const constraints = new Set([
  "billing_subscriptions_app_shape",
  "billing_subscription_revisions_app_shape",
  "organization_entitlements_plan_state_check",
  "billing_subscription_commands_status_shape_check",
  "subscription_allowance_periods_invoice_id_check",
  "subscription_allowance_periods_no_overlap",
]);
const policyPaths = new Set([
  "/policy-fence/begin",
  "/policy-fence/commit",
  "/policy-fence/abort",
]);
const policyPhases = new Set(["transport", "response", "decode"]);

function safeError(value: Record<string, unknown>) {
  return {
    name:
      typeof value.name === "string" && errorNames.has(value.name)
        ? value.name
        : "unknown",
    ...(typeof value.code === "string" &&
      errorCodes.has(value.code) && { code: value.code }),
    ...(typeof value.sqlstate === "string" &&
      /^[0-9A-Z]{5}$/.test(value.sqlstate) && { sqlstate: value.sqlstate }),
    ...(typeof value.constraint === "string" &&
      constraints.has(value.constraint) && { constraint: value.constraint }),
  };
}

function typeErrorLocation(
  value: Record<string, unknown>,
): { line: number; column: number } | undefined {
  if (
    value.name !== "TypeError" ||
    !value.location ||
    typeof value.location !== "object"
  )
    return;
  const { line, column } = value.location as Record<string, unknown>;
  if (
    typeof line === "number" &&
    Number.isSafeInteger(line) &&
    line > 0 &&
    typeof column === "number" &&
    Number.isSafeInteger(column) &&
    column > 0
  )
    return { line, column };
}

/** Projects only our two fixed diagnostic markers from exact checkout POSTs. */
export function checkoutTailSummary(raw: string, expectedUrl: string) {
  let requests = 0;
  const httpStatuses: Record<string, number> = {};
  const failures: object[] = [];
  for (const block of raw.split(/(?<=\n\})\s*(?=\{)/)) {
    let event = null;
    try {
      event = JSON.parse(block);
    } catch {
      continue;
    }
    if (
      event?.event?.request?.method !== "POST" ||
      event.event.request.url !== expectedUrl
    )
      continue;
    requests++;
    const status = event.event.response?.status;
    if (Number.isInteger(status) && status >= 100 && status <= 599)
      httpStatuses[String(status)] = (httpStatuses[String(status)] ?? 0) + 1;
    if (!Array.isArray(event.logs)) continue;
    for (const log of event.logs) {
      if (!Array.isArray(log?.message)) continue;
      const [marker, rawDetails] = log.message;
      if (
        marker !== "[SubscriptionCheckoutConfirm] Failed" &&
        marker !== "[InferencePolicyCall] Failed"
      )
        continue;
      let details = rawDetails;
      if (typeof details === "string") {
        try {
          details = JSON.parse(details);
        } catch {
          continue;
        }
      }
      if (!details || typeof details !== "object" || Array.isArray(details))
        continue;
      if (marker === "[SubscriptionCheckoutConfirm] Failed") {
        if (!checkoutPhases.has(details.phase)) continue;
        const location = typeErrorLocation(details);
        failures.push({
          kind: "checkout",
          phase: details.phase,
          ...safeError(details),
          ...(location ? { location } : {}),
          ...(details.cause &&
            typeof details.cause === "object" &&
            !Array.isArray(details.cause) && {
              cause: safeError(details.cause),
            }),
        });
      } else if (
        policyPaths.has(details.path) &&
        policyPhases.has(details.phase) &&
        (details.httpStatus === null ||
          (Number.isInteger(details.httpStatus) &&
            details.httpStatus >= 100 &&
            details.httpStatus <= 599))
      ) {
        failures.push({
          kind: "policy",
          phase: details.phase,
          path: details.path,
          httpStatus: details.httpStatus,
        });
      }
    }
  }
  return { requests, httpStatuses, failures };
}

if (import.meta.main) {
  let tail: ReturnType<typeof spawn> | undefined;
  try {
    const environment = process.env.ELIZA_OPERATOR_ENVIRONMENT;
    if (environment !== "staging" && environment !== "production")
      throw new Error();
    const checkoutTail = process.argv.includes("--checkout-tail");
    if (
      checkoutTail &&
      (environment !== "staging" ||
        process.env.GITHUB_REF !== "refs/heads/staging")
    )
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
    if (!checkoutTail) {
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
    }
    const url = checkoutTail
      ? "https://api-staging.eliza.app/api/v1/subscriptions/checkout/confirm"
      : `https://${environment === "production" ? "api" : "api-staging"}.eliza.app/api/v1/subscriptions/plans`;
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
        checkoutTail ? "POST" : "GET",
        ...(!checkoutTail
          ? ["--header", `x-eliza-catalog-diagnostic:${nonce}`]
          : []),
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
    if (checkoutTail) {
      console.log(
        JSON.stringify({
          checkoutTail: { state: "ready", windowSeconds: 300 },
        }),
      );
      await delay(300000);
      if (failed || exceeded || tail.exitCode !== null) throw new Error();
      const summary = checkoutTailSummary(output, url);
      output = "";
      console.log(JSON.stringify({ checkoutTail: summary }));
      if (summary.requests === 0) process.exitCode = 1;
    } else {
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
    }
  } catch {
    console.error("subscription_diagnostic_failed");
    process.exitCode = 1;
  } finally {
    if (tail && tail.exitCode === null) {
      tail.kill("SIGTERM");
      await delay(1000);
      if (tail.exitCode === null) tail.kill("SIGKILL");
    }
  }
}
