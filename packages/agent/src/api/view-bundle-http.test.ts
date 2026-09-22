import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, createCharacter, type Plugin } from "@elizaos/core";
import { expect, it } from "vitest";
import { getView, registerPluginViews } from "./views-registry.ts";
import { handleViewsRoutes } from "./views-routes.ts";

it("binds real HTTP bundle bytes and HEAD metadata to the current installation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "view-bundle-http-"));
  const file = path.join(dir, "bundle.js");
  const first = "const value = 1; export { value };\n";
  const second = "const value = 2; export { value };\n";
  await writeFile(file, first);
  await utimes(file, 1_700_000_000, 1_700_000_000);
  const runtime = new AgentRuntime({
    character: createCharacter({ name: "Bundle host" }),
    enableAutonomy: false,
  });
  const plugin: Plugin = {
    name: "bundle-test",
    description: "Local bundle",
    views: [{ id: "bundle", label: "Bundle", bundlePath: "bundle.js" }],
  };
  await registerPluginViews(runtime, plugin, { pluginDir: dir });
  const hostKey = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleViewsRoutes({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? "GET",
      runtime,
      hostKey,
      callerAuthorization: { ok: true, role: "OWNER" },
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
  try {
    const entry = getView(runtime, "bundle");
    expect(entry?.bundleHash).toBe(
      createHash("sha256").update(first).digest("hex"),
    );
    const url = `${origin}${entry?.bundleUrl}`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(first);
    const head = await fetch(url, { method: "HEAD" });
    for (const header of [
      "etag",
      "content-length",
      "x-content-hash",
      "cache-control",
    ])
      expect(head.headers.get(header)).toBe(response.headers.get(header));
    expect(await head.text()).toBe("");

    const wrappedUrl = `${url}&hostExternalRuntime=1&hostExternalSpecifiers=react`;
    const wrapped = await fetch(wrappedUrl);
    const bytes = Buffer.from(await wrapped.arrayBuffer());
    expect(wrapped.headers.get("x-content-hash")).toBe(
      `sha256-${createHash("sha256").update(bytes).digest("base64")}`,
    );
    expect(wrapped.headers.get("etag")).not.toBe(response.headers.get("etag"));
    const wrappedHead = await fetch(wrappedUrl, { method: "HEAD" });
    expect(wrappedHead.headers.get("content-length")).toBe(
      String(bytes.length),
    );
    expect(wrappedHead.headers.get("etag")).toBe(wrapped.headers.get("etag"));

    const originalStat = await stat(file);
    await writeFile(file, second);
    await utimes(file, originalStat.atime, originalStat.mtime);
    expect((await stat(file)).size).toBe(originalStat.size);
    expect((await stat(file)).mtimeMs).toBe(originalStat.mtimeMs);
    const stale = await fetch(url, {
      headers: { "If-None-Match": response.headers.get("etag") ?? "" },
    });
    expect(stale.status).toBe(409);
    await stale.text();
    await registerPluginViews(runtime, plugin, { pluginDir: dir });
    const replacement = getView(runtime, "bundle");
    const fresh = await fetch(`${origin}${replacement?.bundleUrlVersioned}`);
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toBe(second);
    expect(fresh.headers.get("etag")).not.toBe(response.headers.get("etag"));
    const previousUrl = `${origin}${replacement?.bundleUrl}`;
    await registerPluginViews(runtime, plugin, { pluginDir: dir });
    const sameBytesReplacement = getView(runtime, "bundle");
    expect(sameBytesReplacement?.bundleHash).toBe(replacement?.bundleHash);
    expect(sameBytesReplacement?.installationId).not.toBe(
      replacement?.installationId,
    );
    const retired = await fetch(previousUrl);
    expect(retired.status).toBe(409);
    await retired.text();
    const current = await fetch(`${origin}${sameBytesReplacement?.bundleUrl}`);
    expect(current.status).toBe(200);
    expect(await current.text()).toBe(second);
    const unbound = await fetch(
      `${origin}/api/views/bundle/bundle.js?v=${sameBytesReplacement?.bundleHash}`,
    );
    expect(unbound.status).toBe(409);
    await unbound.text();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
