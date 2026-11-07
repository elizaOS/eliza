/** Validate the hosting boundary without changing the agent server's settings. */
export function runtimeSettings(
  serialized: string | undefined,
  environment: string,
): Record<string, string> {
  if (environment !== "staging" && environment !== "production") {
    throw new TypeError("Unknown agent-server deployment environment");
  }
  let input: unknown;
  try {
    input = JSON.parse(serialized ?? "null");
  } catch {
    throw new TypeError("Invalid agent-server runtime configuration JSON");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(
      "AGENT_SERVER_RUNTIME_CONFIG must be a settings object",
    );
  }
  const settings: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      throw new TypeError("Agent-server runtime settings must be strings");
    }
    if (!name.startsWith("RAILWAY_")) settings[name] = value;
  }
  for (const name of [
    "SERVER_NAME",
    "TIER",
    "CAPACITY",
    "AGENT_SERVER_SHARED_SECRET",
    "DATABASE_URL",
    "REDIS_URL",
  ]) {
    if (!settings[name]?.trim()) {
      throw new TypeError(`Missing agent-server setting: ${name}`);
    }
  }
  if (
    !/^[1-9][0-9]*$/.test(settings.CAPACITY) ||
    Number(settings.CAPACITY) > 200
  ) {
    throw new RangeError(
      "Agent-server capacity must be an integer from 1 to 200",
    );
  }
  for (const name of ["ENVIRONMENT", "DEPLOYMENT_ENV"]) {
    if (settings[name] && settings[name] !== environment) {
      throw new TypeError("Agent-server environment does not match deployment");
    }
  }
  const origin = `https://eliza-agent-server-${environment}.square-rain-7251.workers.dev`;
  if (settings.AGENT_SERVER_URL !== origin) {
    throw new TypeError(
      "Agent-server advertised URL must match its deployment",
    );
  }
  for (const name of ["DATABASE_URL", "POSTGRES_URL", "REDIS_URL"]) {
    if (!settings[name]) continue;
    let endpoint: URL;
    try {
      endpoint = new URL(settings[name]);
    } catch {
      throw new TypeError(`Invalid agent-server storage endpoint: ${name}`);
    }
    const protocols =
      name === "REDIS_URL"
        ? ["redis:", "rediss:"]
        : ["postgres:", "postgresql:"];
    if (
      !endpoint.hostname ||
      !protocols.includes(endpoint.protocol) ||
      endpoint.hostname.endsWith(".railway.internal")
    ) {
      throw new TypeError(`Agent-server storage must be reachable: ${name}`);
    }
  }
  return { ...settings, PORT: "3000" };
}
