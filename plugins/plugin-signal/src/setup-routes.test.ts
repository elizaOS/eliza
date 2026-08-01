/**
 * Tests the `/api/setup/signal/*` status/start/cancel route handlers against a
 * mocked pairing layer (no live signal-cli). The route graph is imported once;
 * mutable fake state is reset between cases without exposing test controls from
 * the production module.
 */
import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const pairingMocks = vi.hoisted(() => {
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

  return {
    FakePairingSession,
    moduleEvaluations: 0,
    signalAuthExists: vi.fn((_workspaceDir: string, _accountId: string) => false),
    signalLogout: vi.fn((_workspaceDir: string, _accountId: string) => undefined),
  };
});

vi.mock("./pairing-service", () => {
  pairingMocks.moduleEvaluations += 1;
  return {
    SignalPairingSession: pairingMocks.FakePairingSession,
    sanitizeAccountId(raw: string): string {
      const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "");
      if (!cleaned || cleaned !== raw) {
        throw new Error(
          "Invalid accountId: must only contain alphanumeric characters, dashes, and underscores"
        );
      }
      return cleaned;
    },
    signalAuthExists: pairingMocks.signalAuthExists,
    signalLogout: pairingMocks.signalLogout,
  };
});

import { signalSetupRoutes } from "./setup-routes";

const FakePairingSession = pairingMocks.FakePairingSession;

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

describe("Signal setup routes", () => {
  const signalAuthExists = pairingMocks.signalAuthExists;
  const signalLogout = pairingMocks.signalLogout;

  beforeEach(() => {
    FakePairingSession.instances = [];
    signalAuthExists.mockReset().mockReturnValue(false);
    signalLogout.mockReset().mockImplementation(() => undefined);
  });

  it("rejects hostile account ids before touching auth state", async () => {
    const response = createResponse();

    await signalSetupRoutes[0].handler(
      { url: "/api/setup/signal/status?accountId=../prod" } as RouteRequest,
      response,
      createRuntime(null)
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
      createRuntime(setupService)
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
      phoneNumber: "+155****4567",
    });

    expect(setupService.broadcastWs).toHaveBeenCalledWith({
      type: "signal-status",
      accountId: "work",
      status: "connected",
      phoneNumber: "+155****4567",
    });
    expect(config.connectors.signal).toEqual({
      cliPath: " /opt/signal-cli ",
      accounts: {
        work: {
          label: "Work",
          authDir: "/tmp/eliza-workspace/signal-auth/work",
          enabled: true,
          account: "+155****4567",
        },
      },
      enabled: true,
    });
    expect(setupService.setOwnerContact).toHaveBeenCalledWith({
      source: "signal",
      channelId: "+155****4567",
    });
    expect(setupService.registerEscalationChannel).toHaveBeenCalledWith("signal");
  });

  it("cancels pairing, logs out, and removes only the requested account config", async () => {
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
      createRuntime(setupService)
    );
    const session = FakePairingSession.instances[0];
    const response = createResponse();

    await signalSetupRoutes[2].handler(
      { body: { accountId: "work" } } as RouteRequest,
      response,
      createRuntime(setupService)
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

  it("returns structured errors when cancel cannot log out", async () => {
    signalLogout.mockImplementationOnce(() => {
      throw new Error("auth locked");
    });
    const setupService = {
      getConfig: vi.fn(() => ({})),
      persistConfig: vi.fn(),
      updateConfig: vi.fn(),
      registerEscalationChannel: vi.fn(() => true),
      setOwnerContact: vi.fn(() => true),
      getWorkspaceDir: vi.fn(() => "/tmp/eliza-workspace"),
      broadcastWs: vi.fn(),
    };
    const response = createResponse();

    await signalSetupRoutes[2].handler(
      { body: { accountId: "work" } } as RouteRequest,
      response,
      createRuntime(setupService)
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to disconnect Signal: auth locked",
      },
    });
    expect(setupService.updateConfig).not.toHaveBeenCalled();
  });

  it("returns structured errors when cancel config persistence fails", async () => {
    const setupService = {
      getConfig: vi.fn(() => ({})),
      persistConfig: vi.fn(),
      updateConfig: vi.fn(() => {
        throw new Error("disk full");
      }),
      registerEscalationChannel: vi.fn(() => true),
      setOwnerContact: vi.fn(() => true),
      getWorkspaceDir: vi.fn(() => "/tmp/eliza-workspace"),
      broadcastWs: vi.fn(),
    };
    const response = createResponse();

    await signalSetupRoutes[2].handler(
      { body: { accountId: "work" } } as RouteRequest,
      response,
      createRuntime(setupService)
    );

    expect(signalLogout).toHaveBeenCalledWith("/tmp/eliza-workspace", "work");
    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Failed to persist Signal disconnect: disk full",
      },
    });
  });

  it("does not re-evaluate the route module across warm cases", async () => {
    const evaluationsAtStart = pairingMocks.moduleEvaluations;
    expect(evaluationsAtStart).toBe(1);

    for (let i = 0; i < 4; i += 1) {
      const response = createResponse();
      await signalSetupRoutes[0].handler(
        { url: "/api/setup/signal/status?accountId=../prod" } as RouteRequest,
        response,
        createRuntime(null)
      );
      expect(response.statusCode).toBe(400);
      expect(pairingMocks.moduleEvaluations).toBe(evaluationsAtStart);
    }
  });
});
