import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../platform/platform-guards", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFrontendPlatform: () => "android",
}));
vi.mock("../../first-run/mobile-runtime-mode", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isMobileLocalAgentUrl: (value: string) =>
    value.startsWith("eliza-local-agent:"),
}));
vi.mock("../../state/agent-profiles", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAgentProfileRegistry: () => ({
    profiles: [
      {
        kind: "cloud",
        apiBase: "https://dedicated-agent.example",
        accessToken: "profile-token",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
  }),
}));
vi.mock(
  "@elizaos/plugin-elizacloud/steward-session-client",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    readStoredStewardToken: () => null,
  }),
);

import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../../config/boot-config-store";
import { resolveWorkflowSurfaceTarget } from "../workflow-surface-routing";

describe("workflow surface host policy", () => {
  afterEach(() => setBootConfig(DEFAULT_BOOT_CONFIG));

  it("serves a mobile runtime's workflow surface from a linked Cloud agent by default", () => {
    setBootConfig(DEFAULT_BOOT_CONFIG);
    expect(resolveWorkflowSurfaceTarget("eliza-local-agent://ipc")).toEqual({
      baseUrl: "https://dedicated-agent.example",
      token: "profile-token",
    });
  });

  it("keeps a local-only host's workflow surface on the active agent", () => {
    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      workflowSurfaceCloudFallback: false,
    });
    expect(resolveWorkflowSurfaceTarget("eliza-local-agent://ipc")).toBeNull();
  });
});
