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
  for (const binding of bindings) {
    if (
      !binding ||
      typeof binding.name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.name) ||
      names.has(binding.name)
    )
      throw new Error("Invalid binding inventory");
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

async function main() {
  const environment = process.env.DEPLOY_ENVIRONMENT;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (
    !["staging", "production"].includes(environment) ||
    !/^[a-f0-9]{32}$/.test(account ?? "") ||
    !token
  )
    throw new Error("Missing deployment authority");
  const worker =
    environment === "staging" ? "eliza-cloud-api-staging" : "eliza-cloud-api-prod";
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/settings`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error("Binding inventory unavailable");
  const payload = await response.json();
  if (payload.success !== true) throw new Error("Binding inventory rejected");
  const vars = planStateBackendVars(payload.result?.bindings, process.env);
  // Only fixed selector names and enum values leave this process.
  if (vars.length) process.stdout.write(`${vars.join("\n")}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    console.error(
      "State backend binding inventory failed; refusing deployment",
    );
    process.exitCode = 1;
  });
}
