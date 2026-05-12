import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentSandbox } from "../../db/schemas/agent-sandboxes";
import {
  getClientSafeElizaAgentWebUiUrl,
  getElizaAgentDirectWebUiUrl,
  getElizaAgentPublicWebUiUrl,
  getPreferredElizaAgentWebUiUrl,
} from "../../lib/eliza-agent-web-ui";

const savedAgentBaseDomain = process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;

function makeSandbox(
  overrides: Partial<AgentSandbox> = {},
): Pick<AgentSandbox, "id" | "headscale_ip" | "web_ui_port" | "bridge_port"> {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    headscale_ip: "100.64.0.5",
    web_ui_port: 20100,
    bridge_port: 18800,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = "agent.shad0w.xyz";
});

afterEach(() => {
  if (savedAgentBaseDomain === undefined) {
    delete process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
  } else {
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = savedAgentBaseDomain;
  }
});

describe("getElizaAgentPublicWebUiUrl", () => {
  test("uses configured canonical domain when available", () => {
    expect(getElizaAgentPublicWebUiUrl(makeSandbox())).toBe(
      "https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.agent.shad0w.xyz",
    );
  });

  test("normalizes configured domains with protocol and trailing path", () => {
    expect(
      getElizaAgentPublicWebUiUrl(makeSandbox(), {
        baseDomain: "https://agent.shad0w.xyz/dashboard",
        path: "/chat",
      }),
    ).toBe("https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.agent.shad0w.xyz/chat");
  });

  test("falls back to waifu.fun when env var is unset", () => {
    delete process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;

    expect(getElizaAgentPublicWebUiUrl(makeSandbox())).toBe(
      "https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.waifu.fun",
    );
  });

  test("returns null when explicit baseDomain fails normalization (no silent default)", () => {
    expect(getElizaAgentPublicWebUiUrl(makeSandbox(), { baseDomain: "" })).toBeNull();
    expect(getElizaAgentPublicWebUiUrl(makeSandbox(), { baseDomain: "   " })).toBeNull();
  });

  test("treats baseDomain: undefined like omitted (env then default)", () => {
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = "custom.example";
    expect(getElizaAgentPublicWebUiUrl(makeSandbox(), { baseDomain: undefined })).toBe(
      "https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.custom.example",
    );
  });
});

describe("getPreferredElizaAgentWebUiUrl", () => {
  test("prefers canonical public url over direct node access", () => {
    expect(getPreferredElizaAgentWebUiUrl(makeSandbox())).toBe(
      "https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.agent.shad0w.xyz",
    );
  });

  test("uses waifu.fun default when env var is unset (never falls to direct)", () => {
    delete process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;

    expect(getPreferredElizaAgentWebUiUrl(makeSandbox())).toBe(
      "https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.waifu.fun",
    );
  });

  test("uses waifu.fun default even when web_ui_port is missing", () => {
    delete process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;

    expect(getPreferredElizaAgentWebUiUrl(makeSandbox({ web_ui_port: null }))).toBe(
      "https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.waifu.fun",
    );
  });
});

describe("getClientSafeElizaAgentWebUiUrl", () => {
  test("prefers the server-provided canonical url without consulting env", () => {
    delete process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;

    expect(
      getClientSafeElizaAgentWebUiUrl({
        ...makeSandbox(),
        canonicalWebUiUrl: "https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.agent.shad0w.xyz",
      }),
    ).toBe("https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.agent.shad0w.xyz");
  });

  test("does not fall back to direct access when no canonical url is provided", () => {
    delete process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;

    expect(getClientSafeElizaAgentWebUiUrl(makeSandbox())).toBeNull();
  });
});

describe("getElizaAgentDirectWebUiUrl", () => {
  test("returns null when headscale access is unavailable", () => {
    expect(getElizaAgentDirectWebUiUrl(makeSandbox({ headscale_ip: null }))).toBeNull();
  });
});
