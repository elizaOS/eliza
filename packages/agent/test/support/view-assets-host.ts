/** Owns a temporary real runtime, asset directory and HTTP listener for view delivery tests. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, createCharacter, type Plugin } from "@elizaos/core";
import { getView, registerPluginViews } from "../../src/api/views-registry.ts";
import { handleViewsRoutes } from "../../src/api/views-routes.ts";
export async function createViewAssetHost() {
  const dir = await mkdtemp(path.join(tmpdir(), "view-assets-http-"));
  await mkdir(path.join(dir, "styles"));
  await mkdir(path.join(dir, "media"));
  await writeFile(
    path.join(dir, "frame.html"),
    `<html><head><link rel="stylesheet" href="./styles/main.css"></head><body><div id="target">Asset graph</div><script type="module" src="./main.js"></script></body></html>`,
  );
  await writeFile(
    path.join(dir, "styles/main.css"),
    '#target{color:rgb(11, 22, 33);background-image:url("../media/pixel.svg")}',
  );
  await writeFile(
    path.join(dir, "media/pixel.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path fill="red" d="M0 0h1v1H0z"/></svg>',
  );
  await writeFile(
    path.join(dir, "engine.wasm"),
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  );
  await writeFile(path.join(dir, "child.js"), 'export const message="loaded";');
  await writeFile(
    path.join(dir, "main.js"),
    'import {message} from "./child.js"; await WebAssembly.instantiateStreaming(fetch("./engine.wasm")); document.body.dataset.graph=message;',
  );
  const files = [
    "frame.html",
    "styles/main.css",
    "media/pixel.svg",
    "main.js",
    "child.js",
    "engine.wasm",
  ];
  await writeFile(
    path.join(dir, "frame.html.assets.json"),
    JSON.stringify({ version: 1, files }),
  );
  await writeFile(path.join(dir, "unpublished.d.ts"), "do not serve");
  const runtime = new AgentRuntime({
    character: createCharacter({ name: "Asset graph" }),
    enableAutonomy: false,
  });
  const plugin: Plugin = {
    name: "asset-graph",
    description: "Graph fixture",
    views: [
      {
        id: "graph",
        label: "Graph",
        viewType: "gui",
        roleGate: { minRole: "OWNER" },
        framePath: "frame.html",
        surface: { isolation: "sandboxed-iframe" },
      },
    ],
  };
  await registerPluginViews(runtime, plugin, { pluginDir: dir });
  const hostKey = {};
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleViewsRoutes({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? "GET",
      runtime,
      hostKey,
      callerAuthorization: req.headers["x-denied"]
        ? undefined
        : { ok: true, role: "OWNER" },
      json: (response, body, status = 200) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      },
      error: (response, message, status = 400) => {
        response.writeHead(status);
        response.end(message);
      },
    })
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch((error) => {
        res.writeHead(500);
        res.end(String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing HTTP address");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    dir,
    runtime,
    plugin,
    origin,
    requests,
    url: () => new URL(getView(runtime, "graph")!.frameUrl!, origin),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await runtime.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
