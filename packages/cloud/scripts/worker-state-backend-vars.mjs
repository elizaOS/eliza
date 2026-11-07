import { pathToFileURL } from "node:url";

const selectors = [
  "CLOUD_AUTH_STATE_BACKEND",
  "CLOUD_HF_EGRESS_BACKEND",
  "CLOUD_VOICE_USAGE_BACKEND",
  "CLOUD_RATE_STATE_BACKEND",
  "CLOUD_A2A_STATE_BACKEND",
];

/** Omit Redis defaults only when keep_vars has no existing binding to retain. */
export function planStateBackendVars(bindings, environment) {
  if (!Array.isArray(bindings)) throw new Error("Missing binding inventory");
  const names = new Set();
  for (const [index, binding] of bindings.entries()) {
    // Binding names are public deploy metadata (wrangler lists them too).
    if (
      !binding ||
      typeof binding.name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.name)
    )
      throw new Error(
        `Invalid binding inventory: malformed name at index ${index}${binding?.type ? ` (type ${String(binding.type).replace(/[^a-z0-9_]/gi, "")})` : ""}`,
      );
    if (names.has(binding.name))
      throw new Error(
        `Invalid binding inventory: duplicate binding ${binding.name}`,
      );
    names.add(binding.name);
  }
  return selectors.flatMap((name) => {
    const backend = environment[name];
    if (backend !== "redis" && backend !== "cloudflare")
      throw new Error("Invalid state backend");
    return backend === "cloudflare" || names.has(name)
      ? [`${name}:${backend}`]
      : [];
  });
}

/** A fixed, value-free failure category safe to print in deploy logs. */
export class StateBackendInventoryError extends Error {
  constructor(category, detail = "") {
    super(detail ? `${category} (${detail})` : category);
    this.name = "StateBackendInventoryError";
  }
}

/** Numeric Cloudflare error codes only; messages may echo request data. */
function cloudflareErrorCodes(payload) {
  const codes = Array.isArray(payload?.errors)
    ? payload.errors
        .map((error) => error?.code)
        .filter((code) => Number.isInteger(code))
    : [];
  return codes.length ? `cloudflare codes ${codes.join(",")}` : "";
}

export async function fetchStateBackendVars(environment, fetchImpl = fetch) {
  const deployEnvironment = environment.DEPLOY_ENVIRONMENT;
  const account = environment.CLOUDFLARE_ACCOUNT_ID;
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (
    !["staging", "production"].includes(deployEnvironment) ||
    !/^[a-f0-9]{32}$/.test(account ?? "") ||
    !token
  )
    throw new StateBackendInventoryError("Missing deployment authority");
  const worker =
    deployEnvironment === "staging"
      ? "eliza-cloud-api-staging"
      : "eliza-cloud-api-prod";
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/settings`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new StateBackendInventoryError(
      "Binding inventory unavailable",
      [`HTTP ${response.status}`, cloudflareErrorCodes(payload)]
        .filter(Boolean)
        .join("; "),
    );
  if (payload?.success !== true)
    throw new StateBackendInventoryError(
      "Binding inventory rejected",
      cloudflareErrorCodes(payload),
    );
  try {
    return planStateBackendVars(payload.result?.bindings, environment);
  } catch (error) {
    throw new StateBackendInventoryError(error.message);
  }
}

async function main() {
  const vars = await fetchStateBackendVars(process.env);
  // Only fixed selector names and enum values leave this process.
  if (vars.length) process.stdout.write(`${vars.join("\n")}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    // Categories are fixed strings; never print bindings, tokens or bodies.
    const reason =
      error instanceof StateBackendInventoryError
        ? error.message
        : "unexpected error";
    console.error(
      `State backend binding inventory failed: ${reason}; refusing deployment`,
    );
    process.exitCode = 1;
  });
}
