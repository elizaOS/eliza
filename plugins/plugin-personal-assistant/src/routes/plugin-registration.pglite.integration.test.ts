/** Exercises main-plugin route registration through real HTTP dispatch and PGlite owner records. */
import { once } from "node:events";
import { createServer } from "node:http";
import { resolveOwnerEntityIdOrDefault } from "@elizaos/core";
import { expect, it } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { LifeOpsService } from "../lifeops/service.js";

it("serves owner definition CRUD from the normally registered personal-assistant plugin", async () => {
  const host = await createLifeOpsTestRuntime();
  const runtime = host.runtime;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? "GET",
      runtime,
      isAuthorized: () => true,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP server omitted bound TCP address");
    const base = `http://127.0.0.1:${address.port}`;
    const created = await fetch(`${base}/api/lifeops/definitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Registered owner route",
        kind: "task",
        cadence: { kind: "unscheduled" },
        timezone: "UTC",
        reminderPlan: null,
      }),
    });
    expect(created.status).toBe(201);
    const saved = await created.json();
    expect(saved.definition.title).toBe("Registered owner route");
    const read = await fetch(`${base}/api/lifeops/definitions`);
    expect(read.status).toBe(200);
    expect(
      (await read.json()).definitions.some(
        (row: { definition: { id: string } }) =>
          row.definition.id === saved.definition.id,
      ),
    ).toBe(true);
    const persisted = await new LifeOpsService(runtime, {
      ownerEntityId: resolveOwnerEntityIdOrDefault(runtime),
    }).listDefinitions();
    expect(
      persisted.some((row) => row.definition.id === saved.definition.id),
    ).toBe(true);
    const deleted = await fetch(
      `${base}/api/lifeops/definitions/${saved.definition.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect(
      (
        await new LifeOpsService(runtime, {
          ownerEntityId: resolveOwnerEntityIdOrDefault(runtime),
        }).listDefinitions()
      ).some((row) => row.definition.id === saved.definition.id),
    ).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await host.cleanup();
  }
}, 180000);
