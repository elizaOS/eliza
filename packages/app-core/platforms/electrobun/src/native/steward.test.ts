import { afterEach, describe, expect, it, vi } from "vitest";

const startMock = vi.fn();
const stopMock = vi.fn();
const restartMock = vi.fn();
const getStatusMock = vi.fn();
const getCredentialsMock = vi.fn();
const getApiBaseMock = vi.fn();
const saveStewardCredentialsMock = vi.fn();

vi.mock("@elizaos/app-steward", () => ({
  createDesktopStewardSidecar: vi.fn(() => ({
    start: startMock,
    stop: stopMock,
    restart: restartMock,
    getStatus: getStatusMock,
    getCredentials: getCredentialsMock,
    getApiBase: getApiBaseMock,
  })),
  saveStewardCredentials: saveStewardCredentialsMock,
}));

async function loadModule() {
  vi.resetModules();
  return import("./steward");
}

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

  it("allows explicit enable via STEWARD_LOCAL=true", async () => {
    process.env.STEWARD_LOCAL = "true";
    const module = await loadModule();

    expect(module.isStewardLocalEnabled()).toBe(true);
  });

  it("allows explicit disable via STEWARD_LOCAL=false", async () => {
    process.env.STEWARD_LOCAL = "false";
    const module = await loadModule();

    expect(module.isStewardLocalEnabled()).toBe(false);
  });

  it("persists canonical steward bridge credentials after startup", async () => {
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

    const module = await loadModule();
    await module.startSteward();

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
  });
});
