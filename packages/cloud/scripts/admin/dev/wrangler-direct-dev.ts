#!/usr/bin/env node
/**
 * Test-lane replacement for `wrangler dev` that removes Wrangler's pooled
 * ProxyWorker -> UserWorker HTTP hop.
 *
 * Stock `wrangler dev` runs two workerd processes: a ProxyWorker on the public
 * port forwards every request over a pooled keep-alive connection to the
 * UserWorker runtime. Both kj endpoints close idle keep-alive sockets after
 * 5s, so a request can be written into a pooled socket the UserWorker is
 * closing; it never reaches the Worker and returns a plain-text 500
 * "Network connection lost." (or Wrangler exits with an empty `[ERROR]`).
 * Wrangler only retries GET/HEAD, and no client header controls that hop:
 * https://github.com/cloudflare/workers-sdk/issues/14641
 *
 * This keeps Wrangler's own config, bundler, and Miniflare runtime
 * (`unstable_DevEnv`), but serves the public port with a Node listener that
 * never times out idle clients and forwards each request to the UserWorker
 * over a fresh connection, using the same original-URL and shared-secret
 * headers as the ProxyWorker. No request is ever replayed.
 *
 * Accepts only the `wrangler dev` flags that cloud-api-dev.ts generates and
 * rejects anything else.
 */
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function parseDevArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "dev") {
    throw new Error(
      `wrangler-direct-dev only supports \`dev\`; received ${JSON.stringify(command)}`,
    );
  }
  const options = { vars: {}, envFiles: [] };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === "--local") continue;
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`wrangler-direct-dev: ${flag} requires a value`);
    }
    index++;
    switch (flag) {
      case "--ip":
        options.ip = value;
        break;
      case "--port":
        options.port = parsePort(flag, value);
        break;
      case "--inspector-ip":
        options.inspectorIp = value;
        break;
      case "--inspector-port":
        options.inspectorPort = parsePort(flag, value);
        break;
      case "--env-file":
        options.envFiles.push(value);
        break;
      case "--persist-to":
        options.persistTo = value;
        break;
      case "--var": {
        const separator = value.indexOf(":");
        if (separator <= 0) {
          throw new Error(`wrangler-direct-dev: --var must be KEY:VALUE`);
        }
        options.vars[value.slice(0, separator)] = value.slice(separator + 1);
        break;
      }
      default:
        throw new Error(`wrangler-direct-dev: unsupported flag ${flag}`);
    }
  }
  if (!options.ip || options.port === undefined) {
    throw new Error("wrangler-direct-dev requires --ip and --port");
  }
  return options;
}

function parsePort(flag, value) {
  const port = Number(value);
  if (!/^\d+$/u.test(value) || port > 65_535) {
    throw new Error(`wrangler-direct-dev: ${flag} must be a port number`);
  }
  return port;
}

function forwardedHeaders(rawHeaders, keepUpgrade, replaced = []) {
  const replacedNames = new Set(replaced.map(([name]) => name.toLowerCase()));
  const headers = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const lower = name.toLowerCase();
    if (
      replacedNames.has(lower) ||
      (HOP_BY_HOP_HEADERS.has(lower) &&
        !(keepUpgrade && (lower === "connection" || lower === "upgrade")))
    ) {
      continue;
    }
    headers.push([name, rawHeaders[index + 1]]);
  }
  return headers;
}

function userWorkerTarget(proxyData, req) {
  const innerUrl = new URL(req.url, `http://${req.headers.host}`);
  Object.assign(innerUrl, proxyData.userWorkerInnerUrlOverrides ?? {});
  const { hostname, port } = proxyData.userWorkerUrl;
  const headers = [["MF-Original-URL", innerUrl.href]];
  for (const [name, value] of Object.entries(proxyData.headers ?? {})) {
    if (value !== undefined) headers.push([name, value]);
  }
  return { hostname, port: Number(port), headers };
}

async function main() {
  const options = parseDevArgs(process.argv.slice(2));
  const { unstable_DevEnv: DevEnv } = require(
    require.resolve("wrangler", { paths: [process.cwd()] }),
  );
  const devEnv = new DevEnv();
  const firstReload = new Promise((resolve) => {
    let reloads = 0;
    devEnv.on("reloadComplete", (event) => {
      reloads++;
      if (reloads === 1) {
        resolve(event.proxyData);
        return;
      }
      // `watch: false` means nothing should reload the runtime; forwarding to
      // a replaced UserWorker would target a stale port.
      console.error("[wrangler-direct-dev] unexpected UserWorker reload");
      process.exit(1);
    });
  });
  devEnv.on("error", (event) => {
    console.error("[wrangler-direct-dev] fatal dev runtime error", event);
    process.exit(1);
  });
  devEnv.on("buildFailed", () => {
    console.error("[wrangler-direct-dev] Worker build failed");
    process.exit(1);
  });

  // Tear the runtime down on a signal at any point, including startup, so no
  // workerd process outlives this launcher.
  let server = null;
  const shutdown = async (signal) => {
    server?.close();
    server?.closeAllConnections();
    await devEnv.teardown();
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  let proxyData = null;

  server = createServer((req, res) => {
    if (!proxyData) {
      res.writeHead(503, { "Content-Type": "text/plain;charset=UTF-8" });
      res.end("Worker is starting");
      return;
    }
    const startedAt = performance.now();
    res.on("finish", () => {
      const durationMs = Math.round(performance.now() - startedAt);
      console.log(
        `[wrangler-direct-dev] ${req.method} ${req.url} ${res.statusCode} ${res.statusMessage} (${durationMs}ms)`,
      );
    });
    const target = userWorkerTarget(proxyData, req);
    const upstream = httpRequest({
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      agent: false,
      headers: [
        ...forwardedHeaders(req.rawHeaders, false, target.headers),
        ...target.headers,
        ["Connection", "close"],
      ].flat(),
    });
    upstream.on("response", (upstreamRes) => {
      res.writeHead(
        upstreamRes.statusCode ?? 502,
        upstreamRes.statusMessage,
        forwardedHeaders(upstreamRes.rawHeaders, false).flat(),
      );
      upstreamRes.on("error", (error) => res.destroy(error));
      upstreamRes.pipe(res);
    });
    upstream.on("error", (error) => {
      console.error(
        `[wrangler-direct-dev] ${req.method} ${req.url} failed before a Worker response`,
        error,
      );
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain;charset=UTF-8" });
        res.end(`wrangler-direct-dev upstream error: ${error.message}`);
      } else {
        res.destroy(error);
      }
    });
    req.on("error", (error) => upstream.destroy(error));
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });
  // Never close an idle client connection: a server-side idle close racing a
  // client's next request is the failure this listener exists to remove.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.on("upgrade", (req, socket, head) => {
    if (!proxyData) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    const target = userWorkerTarget(proxyData, req);
    const upstream = connect(target.port, target.hostname, () => {
      const headerLines = [
        ...forwardedHeaders(req.rawHeaders, true, target.headers),
        ...target.headers,
      ].map(([name, value]) => `${name}: ${value}\r\n`);
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n${headerLines.join("")}\r\n`,
      );
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.ip, resolve);
  });
  // Claim the public port before Wrangler allocates any ephemeral listeners.
  await devEnv.startWorker({
    config: path.resolve("wrangler.toml"),
    envFiles: options.envFiles.length > 0 ? options.envFiles : undefined,
    bindings: Object.fromEntries(
      Object.entries(options.vars).map(([key, value]) => [
        key,
        { type: "plain_text", value },
      ]),
    ),
    dev: {
      remote: false,
      watch: false,
      // Wrangler's ProxyWorker still starts, but on an ephemeral port that
      // receives no traffic.
      server: { hostname: "127.0.0.1", port: 0 },
      inspector:
        options.inspectorPort === undefined
          ? false
          : { hostname: options.inspectorIp, port: options.inspectorPort },
      persist: options.persistTo,
    },
  });
  proxyData = await firstReload;
  const overrides = proxyData.userWorkerInnerUrlOverrides ?? {};
  if (overrides.hostname !== undefined || overrides.port !== undefined) {
    // The ProxyWorker would also rewrite URL-bearing headers in this case.
    throw new Error(
      "wrangler-direct-dev does not support inner URL host overrides",
    );
  }

  console.log(
    `[wrangler-direct-dev] UserWorker ${proxyData.userWorkerUrl.hostname}:${proxyData.userWorkerUrl.port}`,
  );
  // Owned-readiness probes match a line ending in `Ready on <url>`, exactly
  // as stock `wrangler dev` announces its public port.
  console.log(
    `[wrangler-direct-dev] Ready on http://${options.ip}:${options.port}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
