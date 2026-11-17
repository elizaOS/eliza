import fs from "node:fs";
import path from "node:path";

export class EmbeddedAgentDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmbeddedAgentDataError";
  }
}

const fail = (message) => {
  throw new EmbeddedAgentDataError(message);
};
const LAUNCH_SETTINGS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "ELIZA_PROVIDER",
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PLATFORM",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_ACTION_ALLOWLIST",
  "ELIZA_PAIRING_DISABLED",
  "ELIZA_DISABLE_LOCAL_CHARACTER",
  "ELIZA_CONFIG_EXTERNAL_SECRET_ENV_VARS",
  "ELIZA_ANDROID_APP_DATA_DIR",
  "ELIZA_BROWSER_ANDROID_APPLICATION",
  "ELIZA_MOBILE_DNS_SERVERS",
  "ELIZA_DEPLOYMENT_RUNTIME",
  "ELIZA_RUNTIME_MODE",
  "ELIZA_DISABLE_LOCAL_EMBEDDINGS",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_BASE_URL",
]);
const CLOUD_ORIGIN =
  /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?$/;
const string = (object, key) => {
  const value = object?.[key];
  if (value === undefined) return "";
  if (typeof value !== "string") fail(`Embedded agent ${key} must be text`);
  return value;
};
const flag = (object, key) => {
  const value = object?.[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean")
    fail(`Embedded agent ${key} must be true or false`);
  return value;
};
const trim = (value) => value.replace(/^[\0- ]+|[\0- ]+$/g, "");
const text = (words, key) => {
  const value = trim(string(words, key));
  if (!value || value.length > 200)
    fail(`Invalid embedded agent notification ${key}`);
  return value;
};

export const EMBEDDED_AGENT_MAX_FILE_BYTES = 256 * 1024;

export function readEmbeddedAgentFile(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length > EMBEDDED_AGENT_MAX_FILE_BYTES)
    fail(`${path.basename(file)} is larger than 256 KB`);
  return JSON.parse(bytes.toString("utf8"));
}

/**
 * The three data files of an embedded agent, read with the rules of the Android
 * service (EmbeddedAgentConfig.java), so a development agent and the device agent
 * run with the same routes, character, policy and settings.
 */
export function parseEmbeddedAgentData({ host, character, policy }) {
  if (host?.schema !== 1 || policy?.schema !== 1)
    fail("Unknown embedded agent schema");
  if (
    typeof host.service !== "string" ||
    !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(host.service)
  )
    fail("Invalid embedded agent service class");
  const notification = {
    channel: text(host.notification, "channel"),
    title: text(host.notification, "title"),
    text: text(host.notification, "text"),
  };
  const baseUrl = host.cloud?.baseUrl;
  if (typeof baseUrl !== "string" || !CLOUD_ORIGIN.test(baseUrl))
    fail("The Eliza Cloud address must be an https origin");
  string(host.cloud, "smallModel");
  string(host.cloud, "largeModel");
  flag(host, "persistMemory");
  if (!Array.isArray(host.routes) || host.routes.length === 0)
    fail("The embedded agent admits no route");
  const routes = host.routes.map((route) => {
    const { method, path: template } = route;
    const stream = flag(route, "stream");
    if (
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
      !/^(\/([A-Za-z0-9._-]+|\{[a-z][A-Za-z]*\}))+$/.test(template ?? "") ||
      /\/\.+(\/|$)/.test(template)
    )
      fail("Invalid embedded agent route");
    const pattern = template
      .split("/")
      .slice(1)
      .map((segment) =>
        segment.startsWith("{")
          ? "[A-Za-z0-9_-]{1,128}"
          : segment.replace(/[.]/g, "\\."),
      )
      .join("/");
    return {
      method,
      stream,
      path: new RegExp(`^/${pattern}$`),
    };
  });
  const record = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (host.environment !== undefined && !record(host.environment))
    fail("The embedded agent environment must be an object");
  for (const [key, value] of Object.entries(host.environment ?? {})) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      LAUNCH_SETTINGS.has(key) ||
      /^(ELIZA_API_|ELIZAOS_CLOUD_|ELIZA_AGENT_|ELIZA_CLOUD_|ELIZA_OWN_|NODE_|LD_)/.test(key) ||
      typeof value !== "string" ||
      /[\0\r\n]/.test(value)
    )
      fail(`The embedded agent environment may not set ${key}`);
  }
  const name = trim(string(character, "name"));
  if (!name || name.length > 50 || !trim(string(character, "system")))
    fail("Invalid embedded agent character");
  const allowed = record(policy.actions?.allowed)
    ? Object.keys(policy.actions.allowed).sort()
    : [];
  if (!allowed.length) fail("The embedded agent policy allows no action");
  const refused =
    policy.actions.refused === undefined ? {} : policy.actions.refused;
  if (!record(refused))
    fail("The embedded agent policy refuses actions by name");
  for (const action of allowed)
    if (Object.hasOwn(refused, action))
      fail(`Action ${action} is both allowed and refused`);
  const plugins = policy.plugins?.load;
  if (!Array.isArray(plugins) || plugins.some((name) => typeof name !== "string" || !name.trim())
      || new Set(plugins).size !== plugins.length)
    fail("The embedded agent policy loads unique plugins by name");
  return { service: host.service, notification, routes };
}
