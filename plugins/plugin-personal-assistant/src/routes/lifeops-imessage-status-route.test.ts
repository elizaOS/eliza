/**
 * Proves the owner-facing LifeOps iMessage status route projects the active
 * runtime transport. The harness uses the real AgentRuntime service registry,
 * LifeOps domain adapter, route dispatcher, and serialized HTTP response while
 * replacing only the external iMessage provider.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  AgentRuntime,
  createCharacter,
  type IAgentRuntime,
  Service,
  stringToUuid,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

vi.mock("./authenticated-entity-principal.js", () => ({
  entityHasVerifiedMachineAuthBinding: vi.fn(async () => false),
}));

const { handleLifeOpsRoutes } = await import("./lifeops-routes.js");

interface CapturedResponse {
  statusCode: number;
  body: string;
}

class BlooioIMessageService extends Service {
  static override serviceType = "imessage";
  capabilityDescription = "Blooio iMessage test transport";
  connected = true;

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<BlooioIMessageService> {
    return new BlooioIMessageService(runtime);
  }

  override async stop(): Promise<void> {}

  isConnected(): boolean {
    return this.connected;
  }

  getStatus() {
    return {
      transport: "blooio" as const,
      available: true,
      connected: this.connected,
      chatDbAvailable: false,
      sendOnly: false,
      chatDbPath: "",
      reason: null,
      permissionAction: null,
      webhookPath: "/api/imessage/webhook/blooio",
      channelId: "channel-test",
    };
  }

  async sendMessage(): Promise<{ success: true; messageId: string }> {
    return { success: true, messageId: "message-test" };
  }
}

interface NativeStatusOverrides {
  connected: boolean;
  chatDbAvailable: boolean;
  permissionAction: {
    type: "full_disk_access";
    label: string;
    url: string;
    instructions: string[];
  } | null;
}

class NativeIMessageService extends Service {
  static override serviceType = "imessage";
  capabilityDescription = "native iMessage test transport";
  connected = true;
  chatDbAvailable = true;
  permissionAction: NativeStatusOverrides["permissionAction"] = null;

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<NativeIMessageService> {
    return new NativeIMessageService(runtime);
  }

  override async stop(): Promise<void> {}

  isConnected(): boolean {
    return this.connected;
  }

  getStatus() {
    return {
      transport: "native" as const,
      available: true,
      connected: this.connected,
      chatDbAvailable: this.chatDbAvailable,
      sendOnly: this.connected && !this.chatDbAvailable,
      chatDbPath: "/Users/owner/Library/Messages/chat.db",
      reason: null,
      permissionAction: this.permissionAction,
      webhookPath: null,
      channelId: null,
    };
  }

  async sendMessage(): Promise<{ success: true; messageId: string }> {
    return { success: true, messageId: "message-test" };
  }
}

function routeContext(runtime: AgentRuntime): {
  context: LifeOpsRouteContext;
  response: CapturedResponse;
} {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const request = new IncomingMessage(socket);
  request.method = "GET";
  const response = new ServerResponse(request);
  const captured: CapturedResponse = { statusCode: 0, body: "" };
  response.statusCode = 0;
  response.end = function end(
    this: ServerResponse,
    chunk?: unknown,
  ): ServerResponse {
    captured.statusCode = this.statusCode;
    captured.body = typeof chunk === "string" ? chunk : "";
    return this;
  };

  const pathname = "/api/lifeops/connectors/imessage/status";
  return {
    context: {
      req: request,
      res: response,
      method: "GET",
      pathname,
      url: new URL(`http://localhost${pathname}`),
      state: { runtime, adminEntityId: null },
      json(res, data, status = 200) {
        res.statusCode = status;
        res.end(JSON.stringify(data));
      },
      error(res, message, status = 400) {
        res.statusCode = status;
        res.end(JSON.stringify({ error: message }));
      },
      async readJsonBody() {
        return null;
      },
      decodePathComponent(raw) {
        return decodeURIComponent(raw);
      },
    },
    response: captured,
  };
}

describe("LifeOps iMessage runtime status projection", () => {
  let runtime: AgentRuntime;
  let imessage: BlooioIMessageService;

  beforeEach(async () => {
    runtime = new AgentRuntime({
      agentId: stringToUuid(`imessage-status-${crypto.randomUUID()}`),
      character: createCharacter({ name: "iMessage status projection" }),
      disableBasicCapabilities: true,
      enableAutonomy: false,
      logLevel: "fatal",
    });
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
    Object.defineProperty(runtime, "adapter", {
      value: null,
      configurable: true,
    });
    await runtime.registerService(BlooioIMessageService);
    const loaded = await runtime.getServiceLoadPromise(
      BlooioIMessageService.serviceType,
    );
    if (!(loaded instanceof BlooioIMessageService)) {
      throw new Error("Blooio iMessage test service did not start.");
    }
    imessage = loaded;
  });

  afterEach(async () => {
    await runtime.stop();
  });

  it("reports Blooio provider API instead of native AppleScript", async () => {
    const { context, response } = routeContext(runtime);

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      available: true,
      connected: true,
      bridgeType: "blooio",
      sendMode: "provider-api",
      diagnostics: [],
      error: null,
      permissionAction: null,
    });
    expect(response.body).not.toContain("apple-script");
    expect(response.body).not.toContain("native_bridge_not_connected");
    expect(response.body).not.toContain("chatDbPath");
  });

  it("reports a disconnected Blooio transport without native diagnostics", async () => {
    imessage.connected = false;
    const { context, response } = routeContext(runtime);

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(JSON.parse(response.body)).toMatchObject({
      available: true,
      connected: false,
      bridgeType: "blooio",
      sendMode: "none",
      diagnostics: ["blooio_transport_not_connected"],
    });
    expect(response.body).not.toContain("native_bridge_not_connected");
    expect(response.body).not.toContain("full_disk_access_required");
  });
});

describe("LifeOps iMessage native transport projection", () => {
  let nativeRuntime: AgentRuntime;
  let nativeService: NativeIMessageService;

  beforeEach(async () => {
    nativeRuntime = new AgentRuntime({
      agentId: stringToUuid(`imessage-native-${crypto.randomUUID()}`),
      character: createCharacter({ name: "iMessage native projection" }),
      disableBasicCapabilities: true,
      enableAutonomy: false,
      logLevel: "fatal",
    });
    await nativeRuntime.initialize({
      allowNoDatabase: true,
      skipMigrations: true,
    });
    Object.defineProperty(nativeRuntime, "adapter", {
      value: null,
      configurable: true,
    });
    await nativeRuntime.registerService(NativeIMessageService);
    const loaded = await nativeRuntime.getServiceLoadPromise(
      NativeIMessageService.serviceType,
    );
    if (!(loaded instanceof NativeIMessageService)) {
      throw new Error("Native iMessage test service did not start.");
    }
    nativeService = loaded;
  });

  afterEach(async () => {
    await nativeRuntime.stop();
  });

  it("reports a connected native transport with chat.db details", async () => {
    const { context, response } = routeContext(nativeRuntime);

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      available: true,
      connected: true,
      bridgeType: "native",
      sendMode: "apple-script",
      diagnostics: [],
      error: null,
      chatDbAvailable: true,
      sendOnly: false,
      chatDbPath: "/Users/owner/Library/Messages/chat.db",
      permissionAction: null,
    });
    expect(response.body).not.toContain("provider-api");
    expect(response.body).not.toContain("blooio_transport_not_connected");
  });

  it("keeps full_disk_access_required diagnostics for a gated native transport", async () => {
    nativeService.connected = false;
    nativeService.chatDbAvailable = false;
    nativeService.permissionAction = {
      type: "full_disk_access",
      label: "Grant Full Disk Access",
      url: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      instructions: [
        "Open System Settings > Privacy & Security > Full Disk Access",
      ],
    };
    const { context, response } = routeContext(nativeRuntime);

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      connected: false,
      bridgeType: "native",
      sendMode: "none",
      diagnostics: ["full_disk_access_required", "native_bridge_not_connected"],
      chatDbAvailable: false,
      sendOnly: false,
      permissionAction: { type: "full_disk_access" },
    });
    expect(response.body).not.toContain("blooio_transport_not_connected");
  });

  it("falls back to chat_db_unavailable when no permission action is present", async () => {
    nativeService.connected = true;
    nativeService.chatDbAvailable = false;
    nativeService.permissionAction = null;
    const { context, response } = routeContext(nativeRuntime);

    await expect(handleLifeOpsRoutes(context)).resolves.toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      connected: true,
      bridgeType: "native",
      sendMode: "apple-script",
      diagnostics: ["chat_db_unavailable"],
      chatDbAvailable: false,
      sendOnly: true,
    });
    expect(response.body).not.toContain("full_disk_access_required");
  });
});
