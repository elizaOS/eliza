import { afterEach, describe, expect, it, vi } from "vitest";

const startMock = vi.fn();
const stopMock = vi.fn();
const restartMock = vi.fn();
const getStatusMock = vi.fn();
const getCredentialsMock = vi.fn();
const getApiBaseMock = vi.fn();
const saveStewardCredentialsMock = vi.fn();
const COLD_NATIVE_IMPORT_TIMEOUT_MS = 45_000;

vi.mock("@elizaos/app-steward/services/steward-sidecar", () => ({
  createDesktopStewardSidecar: vi.fn(() => ({
    start: startMock,
    stop: stopMock,
    restart: restartMock,
    getStatus: getStatusMock,
    getCredentials: getCredentialsMock,
    getApiBase: getApiBaseMock,
  })),
}));

vi.mock("@elizaos/app-steward/services/steward-credentials", () => ({
  saveStewardCredentials: saveStewardCredentialsMock,
}));

const stewardModule = await import("./steward");

describe("native steward bootstrap", () => {
  afterEach(() => {
    delete process.env.STEWARD_LOCAL;
    delete process.env.STEWARD_API_URL;
    delete process.env.STEWARD_AGENT_TOKEN;
    delete process.env.STEWARD_API_KEY;
    delete process.env.STEWARD_TENANT_ID;
    delete process.env.STEWARD_AGENT_ID;
    vi.clearAllMocks();
  });

  it(
    "allows explicit enable via STEWARD_LOCAL=true",
    async () => {
      process.env.STEWARD_LOCAL = "true";

      expect(stewardModule.isStewardLocalEnabled()).toBe(true);
    },
    COLD_NATIVE_IMPORT_TIMEOUT_MS,
  );

  it(
    "allows explicit disable via STEWARD_LOCAL=false",
    async () => {
      process.env.STEWARD_LOCAL = "false";

      expect(stewardModule.isStewardLocalEnabled()).toBe(false);
    },
    COLD_NATIVE_IMPORT_TIMEOUT_MS,
  );

  it(
    "persists canonical steward bridge credentials after startup",
    async () => {
      startMock.mockResolvedValue({
        state: "running",
        port: 3200,
        pid: 123,
        error: null,
        restartCount: 0,
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        agentId: "milady-wallet",
        tenantId: "milady-desktop",
        startedAt: Date.now(),
      });
      getStatusMock.mockReturnValue({
        state: "stopped",
        port: null,
        pid: null,
        error: null,
        restartCount: 0,
        walletAddress: null,
        agentId: null,
        tenantId: null,
        startedAt: null,
      });
      getCredentialsMock.mockReturnValue({
        tenantId: "milady-desktop",
        tenantApiKey: "tenant-key",
        agentId: "milady-wallet",
        agentToken: "agent-token",
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        masterPassword: "",
      });
      getApiBaseMock.mockReturnValue("http://127.0.0.1:3200");

      await stewardModule.startSteward();

      expect(process.env.STEWARD_API_URL).toBe("http://127.0.0.1:3200");
      expect(process.env.STEWARD_AGENT_TOKEN).toBe("agent-token");
      expect(process.env.STEWARD_API_KEY).toBe("tenant-key");
      expect(process.env.STEWARD_TENANT_ID).toBe("milady-desktop");
      expect(process.env.STEWARD_AGENT_ID).toBe("milady-wallet");
      expect(saveStewardCredentialsMock).toHaveBeenCalledWith({
        apiUrl: "http://127.0.0.1:3200",
        tenantId: "milady-desktop",
        agentId: "milady-wallet",
        apiKey: "tenant-key",
        agentToken: "agent-token",
        walletAddresses: {
          evm: "0x1234567890abcdef1234567890abcdef12345678",
        },
        agentName: "milady-wallet",
      });
    },
    COLD_NATIVE_IMPORT_TIMEOUT_MS,
  );
});
