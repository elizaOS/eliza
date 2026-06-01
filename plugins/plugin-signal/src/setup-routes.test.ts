import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

type PairingStatus =
  | "idle"
  | "initializing"
  | "waiting_for_qr"
  | "connected"
  | "disconnected"
  | "timeout"
  | "error";

type PairingEvent = {
  type: "signal-qr" | "signal-status";
  accountId: string;
  qrDataUrl?: string;
  status?: PairingStatus;
  phoneNumber?: string;
  error?: string;
};

type PairingOptions = {
  authDir: string;
  accountId: string;
  cliPath?: string;
  onEvent: (event: PairingEvent) => void;
};

class FakePairingSession {
  static instances: FakePairingSession[] = [];
  readonly start = vi.fn(async () => {});
  readonly stop = vi.fn();
  private status: PairingStatus = "initializing";
  private qrDataUrl: string | null = null;
  private phoneNumber: string | null = null;
  private error: string | null = null;

  constructor(readonly options: PairingOptions) {
    FakePairingSession.instances.push(this);
  }

  getStatus(): PairingStatus {
    return this.status;
  }

  getSnapshot() {
    return {
      status: this.status,
      qrDataUrl: this.qrDataUrl,
      phoneNumber: this.phoneNumber,
      error: this.error,
    };
  }

  emit(event: PairingEvent): void {
    if (event.status) this.status = event.status;
    if (event.qrDataUrl !== undefined) this.qrDataUrl = event.qrDataUrl;
    if (event.phoneNumber !== undefined) this.phoneNumber = event.phoneNumber;
    if (event.error !== undefined) this.error = event.error;
    this.options.onEvent(event);
  }
}

function sanitizeAccountId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!cleaned || cleaned !== raw) {
    throw new Error(
      "Invalid accountId: must only contain alphanumeric characters, dashes, and underscores",
    );
  }
  return cleaned;
}

function createResponse() {
  const response = {
    statusCode: 0,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      response.statusCode = code;
      return response;
    }),
    json: vi.fn((data: unknown) => {
      response.body = data;
      return response;
    }),
    send: vi.fn((data: unknown) => {
      response.body = data;
      return response;
    }),
    end: vi.fn(() => response),
  };
  return response as typeof response & RouteResponse;
}

function createRuntime(setupService: unknown, signalService: unknown = null) {
  return {
    getService: vi.fn((name: string) => {
      if (name === "connector-setup") return setupService;
      if (name === "signal") return signalService;
      return null;
    }),
  } as unknown as IAgentRuntime;
}

async function loadSetupRoutes() {
  vi.resetModules();
  FakePairingSession.instances = [];
  const signalAuthExists = vi.fn(() => false);
  const signalLogout = vi.fn();
  vi.doMock("./pairing-service", () => ({
    SignalPairingSession: FakePairingSession,
    sanitizeAccountId,
    signalAuthExists,
    signalLogout,
  }));
  const mod = await import("./setup-routes");
  return { ...mod, signalAuthExists, signalLogout };
}

describe("Signal setup routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("rejects hostile account ids before touching auth state", async () => {
    const { signalSetupRoutes, signalAuthExists } = await loadSetupRoutes();
    const response = createResponse();

    await signalSetupRoutes[0].handler(
      { url: "/api/setup/signal/status?accountId=../prod" } as RouteRequest,
      response,
      createRuntime(null),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "bad_request",
        message:
          "Invalid accountId: must only contain alphanumeric characters, dashes, and underscores",
      },
    });
    expect(signalAuthExists).not.toHaveBeenCalled();
  });

  it("starts account-scoped pairing and persists connected accounts", async () => {
    const { signalSetupRoutes } = await loadSetupRoutes();
    const config = {
      connectors: {
        signal: {
          cliPath: " /opt/signal-cli ",
          accounts: { work: { label: "Work" } },
        },
      },
    };
    const setupService = {
      getConfig: vi.fn(() => config),
      persistConfig: vi.fn(),
      updateConfig: vi.fn((updater: (cfg: typeof config) => void) => {
        updater(config);
      }),
      registerEscalationChannel: vi.fn(() => true),
      setOwnerContact: vi.fn(() => true),
      getWorkspaceDir: vi.fn(() => "/tmp/eliza-workspace"),
      broadcastWs: vi.fn(),
    };
    const response = createResponse();

    await signalSetupRoutes[1].handler(
      { body: { accountId: "work" } } as RouteRequest,
      response,
      createRuntime(setupService),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      connector: "signal",
      state: "configuring",
      detail: {
        accountId: "work",
        pairingStatus: "initializing",
      },
    });
    expect(FakePairingSession.instances).toHaveLength(1);
    const session = FakePairingSession.instances[0];
    expect(session.options).toMatchObject({
      authDir: "/tmp/eliza-workspace/signal-auth/work",
      accountId: "work",
      cliPath: "/opt/signal-cli",
    });
    expect(session.start).toHaveBeenCalled();

    session.emit({
      type: "signal-status",
      accountId: "work",
      status: "connected",
      phoneNumber: "+15551234567",
    });

    expect(setupService.broadcastWs).toHaveBeenCalledWith({
      type: "signal-status",
      accountId: "work",
      status: "connected",
      phoneNumber: "+15551234567",
    });
    expect(config.connectors.signal).toEqual({
      cliPath: " /opt/signal-cli ",
      accounts: {
        work: {
          label: "Work",
          authDir: "/tmp/eliza-workspace/signal-auth/work",
          enabled: true,
          account: "+15551234567",
        },
      },
      enabled: true,
    });
    expect(setupService.setOwnerContact).toHaveBeenCalledWith({
      source: "signal",
      channelId: "+15551234567",
    });
    expect(setupService.registerEscalationChannel).toHaveBeenCalledWith(
      "signal",
    );
  });

  it("cancels pairing, logs out, and removes only the requested account config", async () => {
    const { signalSetupRoutes, signalLogout } = await loadSetupRoutes();
    const config = {
      connectors: {
        signal: {
          enabled: true,
          accounts: {
            work: { authDir: "/tmp/work" },
            personal: { authDir: "/tmp/personal" },
          },
        },
      },
    };
    const setupService = {
      getConfig: vi.fn(() => config),
      persistConfig: vi.fn(),
      updateConfig: vi.fn((updater: (cfg: typeof config) => void) => {
        updater(config);
      }),
      registerEscalationChannel: vi.fn(() => true),
      setOwnerContact: vi.fn(() => true),
      getWorkspaceDir: vi.fn(() => "/tmp/eliza-workspace"),
      broadcastWs: vi.fn(),
    };

    await signalSetupRoutes[1].handler(
      { body: { accountId: "work" } } as RouteRequest,
      createResponse(),
      createRuntime(setupService),
    );
    const session = FakePairingSession.instances[0];
    const response = createResponse();

    await signalSetupRoutes[2].handler(
      { body: { accountId: "work" } } as RouteRequest,
      response,
      createRuntime(setupService),
    );

    expect(session.stop).toHaveBeenCalled();
    expect(signalLogout).toHaveBeenCalledWith("/tmp/eliza-workspace", "work");
    expect(config.connectors.signal.accounts).toEqual({
      personal: { authDir: "/tmp/personal" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      connector: "signal",
      state: "idle",
      detail: { accountId: "work" },
    });
  });
});
