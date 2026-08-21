/**
 * Hosts the scheduled stability lane's reset authority. It owns one seeded
 * SyntheticWorld, resets every deterministic execution component per request,
 * and returns a versioned proof bound to the requested scenario/model cell.
 */

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { SyntheticWorld } from "@elizaos/synthetic-world";
import { testManifest } from "@elizaos/synthetic-world/test-fixture";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const token = process.env.SCENARIO_STABILITY_RESET_TOKEN?.trim();
if (!token) throw new Error("SCENARIO_STABILITY_RESET_TOKEN is required");
const port = Number(process.env.SCENARIO_STABILITY_RESET_PORT ?? "43191");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  throw new Error("SCENARIO_STABILITY_RESET_PORT must be a valid TCP port");

const manifest = testManifest();
const manifestHash = hash(manifest);
const world = new SyntheticWorld(manifest, "scenario-stability-scheduled");
let generation = 0;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const send = (status: number, value: unknown): void => {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  };
  if (request.method === "GET" && url.pathname === "/health") {
    send(200, {
      status: "ready",
      schemaVersion: "eliza.synthetic-reset-proof/v1",
      manifestHash,
    });
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/reset") {
    send(404, { error: "not found" });
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    send(401, { error: "unauthorized" });
    return;
  }
  let raw = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    raw += chunk;
    if (Buffer.byteLength(raw) > 64 * 1024) request.destroy();
  });
  request.on("end", () => {
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        body = parsed as Record<string, unknown>;
    } catch {
      // error-policy:J3 malformed controller input is rejected explicitly below.
    }
    const target = {
      scenarioId: typeof body?.scenarioId === "string" ? body.scenarioId : "",
      provider: typeof body?.provider === "string" ? body.provider : "",
      model: typeof body?.model === "string" ? body.model : "",
    };
    if (!target.scenarioId || !target.provider || !target.model) {
      send(400, { error: "invalid target" });
      return;
    }
    world.reset();
    generation += 1;
    send(200, {
      schemaVersion: "eliza.synthetic-reset-proof/v1",
      resetId: `reset:${generation}:${randomUUID()}`,
      generation,
      manifestHash,
      executionStateHash: world.executionStateHash,
      providerStateHash: world.stateHash,
      modelRegistryHash: hash({
        provider: target.provider,
        model: target.model,
      }),
      target,
    });
  });
});

const stop = (): void => {
  server.close();
  world.teardown();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`ready http://127.0.0.1:${port}\n`);
});
