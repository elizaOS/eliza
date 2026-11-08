/** Native-prober seam over real loopback HTTP with the production file persistence adapter. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, type PermissionState, type UUID } from "@elizaos/core";
import { afterEach, expect, it } from "vitest";
import { PermissionRegistry } from "../src/services/permissions-registry.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "permission-lifecycle-"));
  const previous = process.env.ELIZA_STATE_DIR;
  process.env.ELIZA_STATE_DIR = directory;
  cleanups.push(async () => {
    if (previous === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const runtime = new AgentRuntime({
    agentId: randomUUID() as UUID,
    character: { name: "Permission lifecycle acceptance", bio: [] },
    logLevel: "fatal",
  });
  const registry = new PermissionRegistry(runtime, { persistDebounceMs: 0 });
  return { directory, registry };
}

async function heldNativeProber(registry: PermissionRegistry) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    calls.push(req.url ?? "");
    if (req.url === "/check" || req.url === "/settings") {
      started();
      await gate;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "camera",
        status: req.url === "/request" ? "granted" : "denied",
        canRequest: true,
        platform: "darwin",
        lastChecked: Date.now(),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing native probe fixture address");
  const probe = async (operation: string) => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/${operation}`,
    );
    return (await response.json()) as PermissionState;
  };
  registry.registerProber({
    id: "camera",
    check: () => probe("check"),
    request: () => probe("request"),
    openSettings: async () => {
      await probe("settings");
      return true;
    },
  });
  return { calls, release, started: startedPromise };
}

it("serializes a permission request behind an older check and persists the newest result", async () => {
  const { registry, directory } = await fixture();
  const native = await heldNativeProber(registry);
  const checking = registry.check("camera");
  await native.started;
  const requesting = registry.request("camera", {
    reason: "camera capture",
    feature: { app: "camera", action: "capture" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(native.calls).toEqual(["/check"]);
  native.release();
  expect((await checking).status).toBe("denied");
  expect((await requesting).status).toBe("granted");
  expect(registry.get("camera").status).toBe("granted");
  await registry.stop();
  expect(
    JSON.parse(
      await readFile(path.join(directory, "permissions.json"), "utf8"),
    ),
  ).toContainEqual(
    expect.objectContaining({ id: "camera", status: "granted" }),
  );
});

it("drains an in-flight native check without publishing its result after stop", async () => {
  const { registry, directory } = await fixture();
  const native = await heldNativeProber(registry);
  registry.recordBlock("camera", { app: "camera", action: "capture" });
  const before = await readFile(
    path.join(directory, "permissions.json"),
    "utf8",
  );
  const checking = registry.check("camera");
  const rejected = expect(checking).rejects.toMatchObject({
    code: "PERMISSION_REGISTRY_STOPPED",
  });
  await native.started;
  let stopped = false;
  const stopping = registry.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(stopped).toBe(false);
  native.release();
  await rejected;
  await stopping;
  expect(registry.get("camera").status).toBe("not-determined");
  expect(await readFile(path.join(directory, "permissions.json"), "utf8")).toBe(
    before,
  );
  await expect(registry.check("camera")).rejects.toMatchObject({
    code: "PERMISSION_REGISTRY_STOPPED",
  });
});

it("retains dirty permission state after a real write failure so stop can retry", async () => {
  const { registry, directory } = await fixture();
  await mkdir(path.join(directory, "permissions.json"));
  expect(() =>
    registry.recordBlock("camera", { app: "camera", action: "capture" }),
  ).toThrow(expect.objectContaining({ code: "PERMISSION_PERSIST_FAILED" }));
  await rm(path.join(directory, "permissions.json"), { recursive: true });
  await registry.stop();
  expect(
    JSON.parse(
      await readFile(path.join(directory, "permissions.json"), "utf8"),
    ),
  ).toContainEqual(
    expect.objectContaining({ id: "camera", status: "not-determined" }),
  );
});

it("drains an admitted settings launch and refuses native UI after stop", async () => {
  const { registry } = await fixture();
  const native = await heldNativeProber(registry);
  const opened = registry.openSettings("camera");
  await native.started;
  let stopped = false;
  const stopping = registry.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(stopped).toBe(false);
  native.release();
  expect(await opened).toBe(true);
  await stopping;
  await expect(registry.openSettings("camera")).rejects.toMatchObject({
    code: "PERMISSION_REGISTRY_STOPPED",
  });
  expect(native.calls).toEqual(["/settings"]);
});
