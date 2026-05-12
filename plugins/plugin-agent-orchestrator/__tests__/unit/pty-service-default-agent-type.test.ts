import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/config-env.ts", () => ({
  readConfigEnvKey: vi.fn((_key: string) => undefined),
  readConfigCloudKey: vi.fn((_key: string) => undefined),
  readConfigCodexSubscriptionRestrictedToCodexFramework: vi.fn(() => false),
}));

import { readConfigEnvKey } from "../../src/services/config-env.ts";
import { PTYService } from "../../src/services/pty-service.ts";

function makeRuntime(settings: Record<string, string | undefined>) {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
    registerService: vi.fn(),
    getService: vi.fn(),
  } as unknown as IAgentRuntime;
}

function instantiate(
  runtimeSettings: Record<string, string | undefined>,
  configEnv: Record<string, string | undefined> = {},
): PTYService {
  (readConfigEnvKey as ReturnType<typeof vi.fn>).mockImplementation(
    (key: string) => configEnv[key],
  );
  return new PTYService(makeRuntime(runtimeSettings));
}

describe("PTYService.defaultAgentType + explicitDefaultAgentType", () => {
  beforeEach(() => {
    (readConfigEnvKey as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to claude when no explicit default is set", () => {
    const svc = instantiate({});
    expect(svc.defaultAgentType).toBe("claude");
  });

  it("accepts PARALLAX_DEFAULT_AGENT_TYPE=opencode from config-file env", () => {
    // Regression: prior to widening the allowed list, opencode was
    // silently rejected and the resolver fell back to claude even when
    // the user explicitly asked for opencode. This pins the fix.
    const svc = instantiate({}, { PARALLAX_DEFAULT_AGENT_TYPE: "opencode" });
    expect(svc.defaultAgentType).toBe("opencode");
  });

  it("accepts PARALLAX_DEFAULT_AGENT_TYPE=opencode from runtime setting (process.env)", () => {
    const svc = instantiate({ PARALLAX_DEFAULT_AGENT_TYPE: "opencode" });
    expect(svc.defaultAgentType).toBe("opencode");
  });

  it("still accepts claude/codex/gemini/aider as before", () => {
    for (const choice of ["claude", "codex", "gemini", "aider"] as const) {
      const svc = instantiate({}, { PARALLAX_DEFAULT_AGENT_TYPE: choice });
      expect(svc.defaultAgentType).toBe(choice);
    }
  });

  it("ignores unrecognized agent types and falls back to claude", () => {
    const svc = instantiate(
      {},
      { PARALLAX_DEFAULT_AGENT_TYPE: "totally-made-up-cli" },
    );
    expect(svc.defaultAgentType).toBe("claude");
  });

  it("config-file value wins over process.env value (when both set)", () => {
    const svc = instantiate(
      { PARALLAX_DEFAULT_AGENT_TYPE: "claude" },
      { PARALLAX_DEFAULT_AGENT_TYPE: "opencode" },
    );
    expect(svc.defaultAgentType).toBe("opencode");
  });
});
