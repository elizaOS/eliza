import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EMBEDDED_AGENT_PREFIX = "/__eliza-embedded-agent";

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
  /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:[0-9]{1,5})?(\/[A-Za-z0-9._~-]+)*\/?$/;
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
  const cloud = baseUrl.replace(/\/+$/, "");
  const smallModel = string(host.cloud, "smallModel");
  const largeModel = string(host.cloud, "largeModel");
  const persistMemory = flag(host, "persistMemory");
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
  const environment = {};
  for (const [key, value] of Object.entries(host.environment ?? {})) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      LAUNCH_SETTINGS.has(key) ||
      /^(ELIZA_API_|ELIZAOS_CLOUD_|LD_)/.test(key) ||
      typeof value !== "string" ||
      /[\0\r\n]/.test(value)
    )
      fail(`The embedded agent environment may not set ${key}`);
    environment[key] = value;
  }
  const name = trim(string(character, "name"));
  if (!name || name.length > 50 || !trim(string(character, "system")))
    fail("Invalid embedded agent character");
  const allowed = record(policy.actions?.allowed)
    ? Object.keys(policy.actions.allowed).sort()
    : [];
  if (!allowed.length) fail("The embedded agent policy allows no action");
  for (const action of allowed)
    if (Object.hasOwn(policy.actions.refused ?? {}, action))
      fail(`Action ${action} is both allowed and refused`);
  const denied =
    policy.plugins?.denied === undefined ? [] : policy.plugins.denied;
  if (!Array.isArray(denied) || denied.some((name) => typeof name !== "string"))
    fail("The embedded agent policy denies plugins by name");
  return {
    service: host.service,
    notification,
    admit(method, requested) {
      return (
        routes.find(
          (route) =>
            route.method === method &&
            typeof requested === "string" &&
            route.path.test(requested),
        ) ?? null
      );
    },
    agentConfig() {
      const cloudRoute = {
        backend: "elizacloud",
        transport: "cloud-proxy",
        accountId: "elizacloud",
      };
      const llmText = {
        ...cloudRoute,
        ...(smallModel ? { smallModel } : {}),
        ...(largeModel ? { largeModel } : {}),
      };
      return {
        deploymentTarget: { runtime: "local" },
        cloud: { enabled: true },
        serviceRouting: { llmText, embeddings: cloudRoute },
        plugins: { deny: denied },
        hooks: { internal: { enabled: false } },
        agents: { list: [{ ...character, default: true }] },
        ui: { assistant: { name } },
        ...(persistMemory
          ? {}
          : {
              database: {
                provider: "pglite",
                pglite: { dataDir: "memory://" },
              },
            }),
      };
    },
    agentEnvironment(credential) {
      if (typeof credential !== "string" || !/^[\x21-\x7e]+$/.test(credential))
        throw new TypeError("A single-line cloud credential is required");
      return {
        ...environment,
        ELIZA_PROVIDER: "elizacloud",
        ELIZAOS_CLOUD_USE_INFERENCE: "true",
        ELIZAOS_CLOUD_API_KEY: credential,
        ELIZAOS_CLOUD_BASE_URL: cloud,
        ...(smallModel ? { ELIZAOS_CLOUD_SMALL_MODEL: smallModel } : {}),
        ...(largeModel ? { ELIZAOS_CLOUD_LARGE_MODEL: largeModel } : {}),
        ELIZA_CONFIG_EXTERNAL_SECRET_ENV_VARS: "ELIZAOS_CLOUD_API_KEY",
        ELIZA_ACTION_ALLOWLIST: JSON.stringify(allowed),
        ELIZA_DISABLE_LOCAL_CHARACTER: "1",
        ELIZA_PAIRING_DISABLED: "1",
        ELIZA_DEPLOYMENT_RUNTIME: "cloud",
        ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
      };
    },
  };
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
const json = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
const ownHost = (req, allowedHosts) => {
  let hostname;
  try {
    hostname = new URL(`http://${req.headers.host}`).hostname;
  } catch {
    return null;
  }
  const bare = hostname.replace(/^\[|\]$/g, "");
  const allowed =
    allowedHosts === true ||
    net.isIP(bare) !== 0 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    allowedHosts.some((entry) =>
      entry.startsWith(".")
        ? hostname === entry.slice(1) || hostname.endsWith(entry)
        : hostname === entry,
    );
  return allowed ? req.headers.host : null;
};
const fromOwnPage = (req, host) => {
  const site = req.headers["sec-fetch-site"];
  const origin = req.headers.origin;
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim();
  return (
    type.toLowerCase() === "application/json" &&
    (site === undefined || site === "same-origin") &&
    (origin === undefined ||
      origin === `http://${host}` ||
      origin === `https://${host}`)
  );
};
const readBody = async (req) => {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new EmbeddedAgentDataError("Request too large");
    chunks.push(chunk);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new EmbeddedAgentDataError("The request is not JSON");
  }
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (input.body !== undefined &&
      (input.body === null ||
        typeof input.body !== "object" ||
        Array.isArray(input.body)))
  )
    throw new EmbeddedAgentDataError("The request is not an agent request");
  return input;
};

/**
 * The development counterpart of the Android embedded agent, as a Vite plugin:
 * it starts the agent from the Eliza checkout at `source` with the same data
 * files and the checkout's own private-runtime launch, and serves the bridge's
 * calls under EMBEDDED_AGENT_PREFIX on the dev server, so the page's web
 * fallback of EmbeddedAgent reaches the same routes without a token. As on the
 * device, private files that cannot be prepared fail the start with `runtime`,
 * a child that cannot be spawned or exits before it is ready fails it with
 * `agent`, and a running child that exits is restarted within `maxRestarts`,
 * then fails with `crashed`. The agent's home is `stateDirectory`, the agent
 * token and the cloud credential stay in this process, and the child is
 * stopped when the dev server closes or this process exits.
 */
export function embeddedAgentDevelopment({
  source,
  data,
  credential,
  stateDirectory,
  command = {
    executable: "bun",
    args: [
      "--no-env-file",
      "--no-install",
      "--conditions=eliza-source",
      "packages/agent/src/bin.ts",
      "serve",
    ],
    cwd: source,
  },
  readyMs = 180000,
  restartDelayMs = 3000,
  maxRestarts = 2,
}) {
  const launcherPath = path.join(
    source,
    "packages/agent/native-host/private-runtime-launch.mjs",
  );
  const quiet = { on() {}, removeListener() {} };
  let status = { available: true, state: "stopped" };
  let admission = null;
  let running = null;
  let endpoint = null;
  let generation = 0;
  const watchers = new Set();
  const publish = (next) => {
    status = { available: true, ...next };
    for (const res of watchers)
      res.write(`data: ${JSON.stringify(status)}\n\n`);
  };
  const failed = (failure, error) =>
    publish({ state: "failed", failure, error });
  const stop = () => {
    generation++;
    endpoint = null;
    void running?.stop();
    running = null;
  };
  const start = async (attempt) => {
    stop();
    const launch = generation;
    const current = () => launch === generation;
    publish({ state: "starting" });
    try {
      admission = parseEmbeddedAgentData({
        host: readEmbeddedAgentFile(data.host),
        character: readEmbeddedAgentFile(data.character),
        policy: readEmbeddedAgentFile(data.policy),
      });
    } catch (error) {
      admission = null;
      return failed("config", error.message);
    }
    let environment;
    try {
      const key = await credential();
      if (!current()) return;
      if (!key)
        return failed("credential", "No Eliza Cloud account is signed in");
      environment = admission.agentEnvironment(key);
    } catch {
      return (
        current() &&
        failed("credential", "The Eliza Cloud credential could not be read")
      );
    }
    let launcher;
    try {
      launcher = await import(pathToFileURL(launcherPath).href);
    } catch {
      return current() && failed("agent", "The agent launch is missing");
    }
    let port;
    const config = path.join(stateDirectory, "config.json");
    try {
      port = await freePort();
      fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
      await launcher.writePrivateRuntimeJson(config, admission.agentConfig());
    } catch {
      return (
        current() &&
        failed("runtime", "The agent's private files could not be prepared")
      );
    }
    if (!current()) return;
    let child;
    const token = randomBytes(48).toString("base64url");
    try {
      child = await launcher.startPrivateRuntimeProcess({
        command: command.executable,
        args: command.args,
        cwd: command.cwd,
        stdio: ["ignore", "inherit", "inherit"],
        signalSource: quiet,
        env: launcher.runtimeEnvironment({
          inherited: process.env,
          allow: ["PATH", "TMPDIR"],
          settings: environment,
          owned: {
            HOME: stateDirectory,
            ELIZA_STATE_DIR: stateDirectory,
            ELIZA_CONFIG_PATH: config,
            ELIZA_API_BIND: "127.0.0.1",
            ELIZA_API_PORT: String(port),
            ELIZA_API_STRICT_PORT: "true",
            ELIZA_REQUIRE_LOCAL_AUTH: "1",
            ELIZA_API_TOKEN: token,
          },
        }),
      });
    } catch {
      return current() && failed("agent", "The agent could not be started");
    }
    if (!current()) return void child.stop();
    running = child;
    let ready = false;
    let exited = false;
    void child.completion.then(() => {
      exited = true;
      if (!current() || !ready) return;
      endpoint = null;
      running = null;
      if (attempt >= maxRestarts)
        return failed("crashed", "The agent stopped too often");
      publish({ state: "starting" });
      setTimeout(
        () => {
          if (current()) void start(attempt + 1);
        },
        restartDelayMs * (attempt + 1),
      ).unref();
    });
    const deadline = Date.now() + readyMs;
    while (current() && !exited && Date.now() < deadline) {
      try {
        const answer = await fetch(`http://127.0.0.1:${port}/api/status`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1000),
        });
        if (answer.ok && current() && !exited) {
          ready = true;
          endpoint = { port, token };
          return publish({ state: "running" });
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!current()) return;
    stop();
    failed(
      "agent",
      exited
        ? "The agent exited before it was ready"
        : "The agent did not answer in time",
    );
  };

  const forward = async (req, res, stream) => {
    const input = await readBody(req);
    const route = admission?.admit(input.method, input.path);
    if (!route || route.stream !== stream)
      return json(res, 403, {
        code: "ROUTE_REFUSED",
        error: "This agent route is not available",
      });
    if (!endpoint)
      return json(res, 503, {
        code: "RUNTIME_NOT_READY",
        error: "The agent is not ready",
      });
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const answer = await fetch(
      `http://127.0.0.1:${endpoint.port}${input.path}`,
      {
        method: input.method,
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          "Content-Type": "application/json",
          ...(stream ? { Accept: "text/event-stream" } : {}),
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
        signal: controller.signal,
      },
    );
    const type = answer.headers.get("content-type") ?? "";
    if (stream && type.startsWith("text/event-stream")) {
      res.writeHead(answer.status, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      });
      for await (const chunk of answer.body) res.write(chunk);
      return res.end();
    }
    return json(res, 200, { status: answer.status, data: await answer.json() });
  };

  const handle = async (req, res, allowedHosts) => {
    const host = ownHost(req, allowedHosts);
    if (!host || (req.method !== "GET" && !fromOwnPage(req, host)))
      return json(res, 403, {
        code: "ORIGIN_REFUSED",
        error: "Only this development server's page may use the agent",
      });
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/status")
      return json(res, 200, status);
    if (req.method === "GET" && url.pathname === "/status/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      });
      res.write(`data: ${JSON.stringify(status)}\n\n`);
      watchers.add(res);
      return res.on("close", () => watchers.delete(res));
    }
    if (req.method !== "POST") return json(res, 404, {});
    if (url.pathname === "/start") {
      if (!["starting", "running"].includes(status.state)) void start(0);
      return json(res, 200, status);
    }
    if (url.pathname === "/restart") {
      void start(0);
      return json(res, 200, status);
    }
    if (url.pathname === "/stop") {
      stop();
      publish({ state: "stopped" });
      return json(res, 200, status);
    }
    if (url.pathname === "/request") return forward(req, res, false);
    if (url.pathname === "/stream") return forward(req, res, true);
    return json(res, 404, {});
  };

  return {
    name: "eliza-embedded-agent",
    configureServer(server) {
      server.middlewares.use(EMBEDDED_AGENT_PREFIX, (req, res) => {
        handle(req, res, server.config?.server?.allowedHosts ?? []).catch(
          (error) => {
            if (!res.headersSent)
              json(res, error instanceof EmbeddedAgentDataError ? 400 : 502, {
                error: "The agent request failed",
                ...(error instanceof EmbeddedAgentDataError
                  ? { code: "INVALID_REQUEST" }
                  : {}),
              });
            else res.destroy();
          },
        );
      });
      server.httpServer?.once("close", stop);
      process.once("exit", stop);
      void start(0);
    },
  };
}
