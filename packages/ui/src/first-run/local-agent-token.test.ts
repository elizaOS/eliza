/**
 * Verifies Android local-agent token hydration cannot expose the bundled
 * agent credential to an adb-reversed remote runtime. Native APIs are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  setBootConfig,
} from "../config/boot-config";
import { hydrateAndroidLocalAgentTokenForUrl } from "./local-agent-token";

const { elizaGlobals, getLocalAgentTokenMock, routingState } = vi.hoisted(
  () => ({
    elizaGlobals: { apiToken: null as string | null },
    getLocalAgentTokenMock: vi.fn(),
    routingState: { eligible: false },
  }),
);

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "android",
  },
}));

vi.mock("../bridge/native-plugins", () => ({
  getAgentPlugin: () => ({
    getLocalAgentToken: getLocalAgentTokenMock,
  }),
}));

vi.mock("../utils/eliza-globals", () => ({
  getElizaApiToken: () => elizaGlobals.apiToken,
  setElizaApiToken: (token: string) => {
    elizaGlobals.apiToken = token;
  },
}));

vi.mock("./android-local-agent-routing", () => ({
  shouldRouteAndroidRequestToLocalAgent: () => routingState.eligible,
}));

describe("hydrateAndroidLocalAgentTokenForUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBootConfig(DEFAULT_BOOT_CONFIG);
    elizaGlobals.apiToken = null;
    routingState.eligible = false;
    getLocalAgentTokenMock.mockResolvedValue({
      available: true,
      token: "native-local-agent-token",
    });
  });

  afterEach(() => {
    setBootConfig(DEFAULT_BOOT_CONFIG);
  });

  it("does not read or install the native token for remote-mac loopback", async () => {
    await expect(
      hydrateAndroidLocalAgentTokenForUrl(
        "http://127.0.0.1:31337/api/auth/status",
        { force: true },
      ),
    ).resolves.toBeNull();

    expect(getLocalAgentTokenMock).not.toHaveBeenCalled();
    expect(getBootConfig().apiToken).toBeUndefined();
    expect(elizaGlobals.apiToken).toBeNull();
  });

  it("hydrates the native token for loopback in local mode", async () => {
    routingState.eligible = true;

    await expect(
      hydrateAndroidLocalAgentTokenForUrl(
        "http://127.0.0.1:31337/api/auth/status",
        { force: true },
      ),
    ).resolves.toBe("native-local-agent-token");

    expect(getLocalAgentTokenMock).toHaveBeenCalledOnce();
    expect(getBootConfig().apiToken).toBe("native-local-agent-token");
    expect(elizaGlobals.apiToken).toBe("native-local-agent-token");
  });

  it("hydrates the native token for explicit IPC regardless of persisted mode", async () => {
    routingState.eligible = true;

    await expect(
      hydrateAndroidLocalAgentTokenForUrl(
        "eliza-local-agent://ipc/api/auth/status",
        { force: true },
      ),
    ).resolves.toBe("native-local-agent-token");

    expect(getLocalAgentTokenMock).toHaveBeenCalledOnce();
    expect(getBootConfig().apiToken).toBe("native-local-agent-token");
  });
});
