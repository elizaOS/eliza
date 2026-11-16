import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

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
]);
const text = (words, key) => {
  const value = typeof words?.[key] === "string" ? words[key].trim() : "";
  if (!value || value.length > 200)
    fail(`Invalid embedded agent notification ${key}`);
  return value;
};

/**
 * The three data files of an embedded agent, read with the rules of the Android
 * service (EmbeddedAgentConfig.java), so a development agent and the device agent
 * run with the same routes, character, policy and settings.
 */
export function parseEmbeddedAgentData({ host, character, policy }) {
  if (host?.schema !== 1 || policy?.schema !== 1)
    fail("Unknown embedded agent schema");
  if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(host.service ?? ""))
    fail("Invalid embedded agent service class");
  const notification = {
    channel: text(host.notification, "channel"),
    title: text(host.notification, "title"),
    text: text(host.notification, "text"),
  };
  let cloud;
  try {
    cloud = new URL(host.cloud?.baseUrl);
  } catch {
    fail("The Eliza Cloud address must be an https origin");
  }
  if (cloud.protocol !== "https:" || cloud.search || cloud.username)
    fail("The Eliza Cloud address must be an https origin");
  const { smallModel = "", largeModel = "" } = host.cloud;
  if (!Array.isArray(host.routes) || host.routes.length === 0)
    fail("The embedded agent admits no route");
  const routes = host.routes.map(({ method, path: template, stream }) => {
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
      stream: stream === true,
      path: new RegExp(`^/${pattern}$`),
    };
  });
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
  const name = typeof character?.name === "string" ? character.name.trim() : "";
  if (!name || name.length > 50 || !character.system?.trim?.())
    fail("Invalid embedded agent character");
  const allowed = Object.keys(policy.actions?.allowed ?? {}).sort();
  if (!allowed.length) fail("The embedded agent policy allows no action");
  for (const action of allowed)
    if (Object.hasOwn(policy.actions.refused ?? {}, action))
      fail(`Action ${action} is both allowed and refused`);
  const denied = (policy.plugins?.denied ?? []).map(String);
  return {
    service: host.service,
    notification,
    admit(method, requested) {
      return (
        routes.find(
          (route) => route.method === method && route.path.test(requested),
        ) ?? null
      );
    },
    agentConfig() {
      const llmText = {
        backend: "elizacloud",
        transport: "cloud-proxy",
        accountId: "elizacloud",
        ...(smallModel ? { smallModel } : {}),
        ...(largeModel ? { largeModel } : {}),
      };
      return {
        deploymentTarget: { runtime: "local" },
        cloud: { enabled: true },
        serviceRouting: { llmText },
        plugins: { deny: denied },
        hooks: { internal: { enabled: false } },
        agents: { list: [{ ...character, default: true }] },
        ui: { assistant: { name } },
        ...(host.persistMemory === true
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
        ELIZAOS_CLOUD_BASE_URL: cloud.href.replace(/\/+$/, ""),
        ...(smallModel ? { ELIZAOS_CLOUD_SMALL_MODEL: smallModel } : {}),
        ...(largeModel ? { ELIZAOS_CLOUD_LARGE_MODEL: largeModel } : {}),
        ELIZA_CONFIG_EXTERNAL_SECRET_ENV_VARS: "ELIZAOS_CLOUD_API_KEY",
        ELIZA_ACTION_ALLOWLIST: JSON.stringify(allowed),
        ELIZA_DISABLE_LOCAL_CHARACTER: "1",
        ELIZA_PAIRING_DISABLED: "1",
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
const readBody = async (req) => {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new EmbeddedAgentDataError("Request too large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

/**
 * The development counterpart of the Android embedded agent, as a Vite plugin:
 * it starts the agent from the Eliza checkout at `source` with the same data
 * files, restarts it after a crash within the same budget, and serves
 * the bridge's calls under EMBEDDED_AGENT_PREFIX on the dev server, so the page's
 * web fallback of EmbeddedAgent reaches the same routes without a token. The agent
 * token and the cloud credential stay in this process.
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
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  let status = { available: true, state: "stopped" };
  let child = null;
  let endpoint = null;
  let restarts = 0;
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
    child?.kill("SIGTERM");
    child = null;
  };
  const start = async (fresh) => {
    stop();
    const launch = generation;
    if (fresh) restarts = 0;
    publish({ state: "starting" });
    let parsed;
    try {
      parsed = parseEmbeddedAgentData({
        host: read(data.host),
        character: read(data.character),
        policy: read(data.policy),
      });
    } catch (error) {
      return failed("config", error.message);
    }
    let key;
    try {
      key = await credential();
    } catch {
      return failed(
        "credential",
        "The Eliza Cloud credential could not be read",
      );
    }
    if (!key)
      return failed("credential", "No Eliza Cloud account is signed in");
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const config = path.join(stateDirectory, "config.json");
    fs.writeFileSync(config, JSON.stringify(parsed.agentConfig()), {
      mode: 0o600,
    });
    const token = randomBytes(48).toString("base64url");
    const port = await freePort();
    const spawned = spawn(command.executable, command.args, {
      cwd: command.cwd,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR ?? "",
        ...parsed.agentEnvironment(key),
        ELIZA_STATE_DIR: stateDirectory,
        ELIZA_CONFIG_PATH: config,
        ELIZA_API_BIND: "127.0.0.1",
        ELIZA_API_PORT: String(port),
        ELIZA_API_STRICT_PORT: "true",
        ELIZA_REQUIRE_LOCAL_AUTH: "1",
        ELIZA_API_TOKEN: token,
      },
    });
    child = spawned;
    spawned.once("exit", () => {
      if (launch !== generation) return;
      endpoint = null;
      child = null;
      if (restarts >= maxRestarts)
        return failed("crashed", "Native child stopped unexpectedly");
      restarts++;
      publish({ state: "starting" });
      setTimeout(() => {
        if (launch === generation) void start(false);
      }, restartDelayMs * restarts).unref();
    });
    const deadline = Date.now() + readyMs;
    while (launch === generation && Date.now() < deadline) {
      try {
        const answer = await fetch(`http://127.0.0.1:${port}/api/status`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1000),
        });
        if (answer.ok) {
          endpoint = { port, token, parsed };
          return publish({ state: "running" });
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (launch === generation) {
      stop();
      failed("agent", "Native child readiness timed out");
    }
  };

  const forward = async (req, res, stream) => {
    const input = await readBody(req);
    const route = endpoint?.parsed.admit(input.method, input.path);
    if (!endpoint) return json(res, 503, { code: "RUNTIME_NOT_READY" });
    if (!route || route.stream !== stream)
      return json(res, 403, { code: "ROUTE_REFUSED" });
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

  const handle = async (req, res) => {
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
      if (!["starting", "running"].includes(status.state)) void start(true);
      return json(res, 200, status);
    }
    if (url.pathname === "/restart") {
      void start(true);
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
        handle(req, res).catch((error) => {
          if (!res.headersSent)
            json(res, error instanceof EmbeddedAgentDataError ? 400 : 502, {
              error: "The agent request failed",
            });
          else res.end();
        });
      });
      server.httpServer?.once("close", stop);
      void start(true);
    },
  };
}
