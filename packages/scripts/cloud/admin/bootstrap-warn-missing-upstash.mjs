// Drives cloud admin cloud admin bootstrap warn missing upstash automation with explicit environment and CI invariants.
export function warnMissingUpstash(
  env,
  write = (message) => process.stderr.write(message),
) {
  const hasRestUrl = Boolean(
    env.KV_REST_API_URL?.trim() || env.UPSTASH_REDIS_REST_URL?.trim(),
  );
  const hasRestToken = Boolean(
    env.KV_REST_API_TOKEN?.trim() || env.UPSTASH_REDIS_REST_TOKEN?.trim(),
  );

  if (hasRestUrl && hasRestToken) {
    return false;
  }

  const missing = [];
  if (!hasRestUrl) {
    missing.push("KV_REST_API_URL or UPSTASH_REDIS_REST_URL");
  }
  if (!hasRestToken) {
    missing.push("KV_REST_API_TOKEN or UPSTASH_REDIS_REST_TOKEN");
  }

  write(
    [
      "[bootstrap-provisioning-worker-host] warning: shared Upstash registry credentials are incomplete.",
      `Missing: ${missing.join(", ")}.`,
      "Sandbox containers may start, but platform gateways will not be able to route inbound messages to them until the orchestrator has registry credentials.",
      "",
    ].join("\n"),
  );
  return true;
}
