import { Hono, type Context } from "hono";
import { injectLatency } from "./latency";
import {
  createAction,
  scheduleActionSuccess,
  schedulePowerTransition,
  scheduleServerCreationProgression,
  scheduleServerDeletion,
  type ProgressionOptions,
} from "./progression";
import { HetznerStore } from "./store";
import type { ErrorEnvelope, MockServer, MockVolume } from "./types";

export interface HetznerMockAppOptions {
  /** Override action lifecycle duration in ms. Default 2000. */
  actionMs?: number;
  /** Optional store override (for tests sharing state). */
  store?: HetznerStore;
}

export function buildHetznerMockApp(options: HetznerMockAppOptions = {}): {
  app: Hono;
  store: HetznerStore;
  progression: ProgressionOptions;
} {
  const store = options.store ?? new HetznerStore();
  const progression: ProgressionOptions = { actionMs: options.actionMs ?? 2000 };
  const app = new Hono();

  // ---- Auth middleware --------------------------------------------------
  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!auth || !auth.startsWith("Bearer ") || auth.slice(7).trim() === "") {
      return c.json<ErrorEnvelope>(
        { error: { code: "unauthorized", message: "Missing or invalid bearer token" } },
        401,
      );
    }
    await next();
  });

  // ---- Servers ----------------------------------------------------------
  app.post("/servers", async (c) => {
    await injectLatency("POST /servers");
    const body = await safeJson(c);
    const name = typeof body.name === "string" ? body.name : null;
    const serverType = typeof body.server_type === "string" ? body.server_type : null;
    const locationName = typeof body.location === "string" ? body.location : null;
    if (!name || !serverType || !locationName) {
      return c.json<ErrorEnvelope>(
        {
          error: {
            code: "invalid_input",
            message: "name, server_type and location are required",
            details: { fields: ["name", "server_type", "location"] },
          },
        },
        422,
      );
    }
    const userData = typeof body.user_data === "string" ? body.user_data : "";
    if (userData.length > 32 * 1024) {
      return c.json<ErrorEnvelope>(
        {
          error: {
            code: "invalid_input",
            message: `user_data exceeds 32 KiB (${userData.length} bytes)`,
          },
        },
        422,
      );
    }

    const location = store.resolveLocation(locationName);
    const labels =
      body.labels && typeof body.labels === "object"
        ? (body.labels as Record<string, string>)
        : {};
    const id = store.allocServerId();
    const server: MockServer = {
      id,
      name,
      status: "initializing",
      created: new Date().toISOString(),
      public_net: {
        ipv4: { ip: store.randomIpv4(), blocked: false },
        ipv6: null,
      },
      server_type: { id: hashId(serverType), name: serverType },
      datacenter: { id: location.id, name: `${location.name}-dc1`, location },
      labels,
    };
    store.servers.set(id, server);

    const action = createAction(store, "create_server", [{ id, type: "server" }]);
    scheduleServerCreationProgression(store, server, action.id, progression);

    return c.json(
      { server, action, next_actions: [], root_password: null },
      201,
    );
  });

  app.get("/servers", async (c) => {
    await injectLatency("GET /servers");
    const labelSelector = c.req.query("label_selector");
    let servers = [...store.servers.values()];
    if (labelSelector) {
      const filters = parseLabelSelector(labelSelector);
      servers = servers.filter((s) =>
        filters.every(([k, v]) => s.labels[k] === v),
      );
    }
    return c.json({ servers });
  });

  app.get("/servers/:id", async (c) => {
    await injectLatency("GET /servers/:id");
    const id = Number(c.req.param("id"));
    const server = store.servers.get(id);
    if (!server) return notFound(c, "server", id);
    return c.json({ server });
  });

  app.delete("/servers/:id", async (c) => {
    await injectLatency("DELETE /servers/:id");
    const id = Number(c.req.param("id"));
    const server = store.servers.get(id);
    if (!server) return notFound(c, "server", id);
    server.status = "deleting";
    const action = createAction(store, "delete_server", [{ id, type: "server" }]);
    server._deletePendingActionId = action.id;
    scheduleServerDeletion(store, id, action.id, progression);
    return c.json({ action });
  });

  app.post("/servers/:id/actions/:cmd", async (c) => {
    await injectLatency("POST /servers/:id/actions/:cmd");
    const id = Number(c.req.param("id"));
    const cmd = c.req.param("cmd");
    const server = store.servers.get(id);
    if (!server) return notFound(c, "server", id);

    let command: string;
    let target: MockServer["status"];
    switch (cmd) {
      case "poweroff":
        command = "stop_server";
        target = "off";
        server.status = "stopping";
        break;
      case "poweron":
        command = "start_server";
        target = "running";
        server.status = "starting";
        break;
      default:
        return c.json<ErrorEnvelope>(
          { error: { code: "invalid_input", message: `Unsupported action: ${cmd}` } },
          422,
        );
    }
    const action = createAction(store, command, [{ id, type: "server" }]);
    schedulePowerTransition(store, id, action.id, target, progression);
    return c.json({ action });
  });

  // ---- Actions ----------------------------------------------------------
  app.get("/actions/:id", async (c) => {
    await injectLatency("GET /actions/:id");
    const id = Number(c.req.param("id"));
    const action = store.actions.get(id);
    if (!action) return notFound(c, "action", id);
    return c.json({ action });
  });

  // ---- Volumes ----------------------------------------------------------
  app.post("/volumes", async (c) => {
    await injectLatency("POST /volumes");
    const body = await safeJson(c);
    const name = typeof body.name === "string" ? body.name : null;
    const size = typeof body.size === "number" ? body.size : null;
    const locationName = typeof body.location === "string" ? body.location : null;
    if (!name || !size || !locationName) {
      return c.json<ErrorEnvelope>(
        {
          error: {
            code: "invalid_input",
            message: "name, size and location are required",
          },
        },
        422,
      );
    }
    const location = store.resolveLocation(locationName);
    const id = store.allocVolumeId();
    const attachedServer = typeof body.server === "number" ? body.server : null;
    const volume: MockVolume = {
      id,
      name,
      size,
      linux_device: attachedServer
        ? `/dev/disk/by-id/scsi-0HC_Volume_${id}`
        : null,
      server: attachedServer,
      location,
      format: typeof body.format === "string" ? body.format : "ext4",
      status: "creating",
      labels:
        body.labels && typeof body.labels === "object"
          ? (body.labels as Record<string, string>)
          : {},
      created: new Date().toISOString(),
    };
    store.volumes.set(id, volume);
    const action = createAction(store, "create_volume", [{ id, type: "volume" }]);
    scheduleActionSuccess(store, action.id, progression, () => {
      const v = store.volumes.get(id);
      if (v) v.status = "available";
    });
    return c.json({ volume, action, next_actions: [] }, 201);
  });

  app.post("/volumes/:id/actions/attach", async (c) => {
    await injectLatency("POST /volumes/:id/actions/attach");
    const id = Number(c.req.param("id"));
    const volume = store.volumes.get(id);
    if (!volume) return notFound(c, "volume", id);
    const body = await safeJson(c);
    const serverId = typeof body.server === "number" ? body.server : null;
    if (!serverId) {
      return c.json<ErrorEnvelope>(
        { error: { code: "invalid_input", message: "server is required" } },
        422,
      );
    }
    const action = createAction(store, "attach_volume", [
      { id, type: "volume" },
      { id: serverId, type: "server" },
    ]);
    scheduleActionSuccess(store, action.id, progression, () => {
      const v = store.volumes.get(id);
      if (!v) return;
      v.server = serverId;
      v.linux_device = `/dev/disk/by-id/scsi-0HC_Volume_${id}`;
    });
    return c.json({ action });
  });

  app.delete("/volumes/:id", async (c) => {
    await injectLatency("DELETE /volumes/:id");
    const id = Number(c.req.param("id"));
    const volume = store.volumes.get(id);
    if (!volume) return notFound(c, "volume", id);
    store.volumes.delete(id);
    return c.body(null, 204);
  });

  return { app, store, progression };
}

// ---- Helpers ------------------------------------------------------------

function notFound(c: Context, resource: string, id: number) {
  return c.json<ErrorEnvelope>(
    { error: { code: "not_found", message: `${resource} ${id} not found` } },
    404,
  );
}

async function safeJson(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseLabelSelector(raw: string): Array<[string, string]> {
  return raw
    .split(",")
    .map((pair) => pair.split("="))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([k, v]) => [decodeURIComponent(k), decodeURIComponent(v)]);
}

function hashId(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}
