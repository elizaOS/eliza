// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { clearElizaApiBase } from "../utils/eliza-globals";
import { ElizaClient } from "./client-base";

describe("ElizaClient Cloud API base restore", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearElizaApiBase();
    setBootConfig({ branding: {} });
  });

  it("ignores the bare Cloud control plane as a runtime API base", () => {
    localStorage.setItem("elizaos_api_base", "https://api.elizacloud.ai/");

    const client = new ElizaClient();

    expect(client.getBaseUrl()).toBe("");
  });

  it("keeps a Cloud bridge URL hosted on the Cloud API domain", () => {
    const bridgeUrl =
      "https://api.elizacloud.ai/api/v1/eliza/agents/agent-123/bridge";
    localStorage.setItem("elizaos_api_base", bridgeUrl);

    const client = new ElizaClient();

    expect(client.getBaseUrl()).toBe(bridgeUrl);
  });
});
