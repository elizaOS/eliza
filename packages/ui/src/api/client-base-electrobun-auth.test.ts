/** Packaged renderer auth follows the native host's live API ownership. */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";

type RendererWindow = Window & {
  __ELIZA_ELECTROBUN_RPC__?: {
    request: Record<string, (...args: unknown[]) => Promise<unknown>>;
    onMessage: (name: string, listener: (payload: unknown) => void) => void;
    offMessage: (name: string, listener: (payload: unknown) => void) => void;
  };
};

const runtimeWindow = window as RendererWindow;
const LOCAL_BASE = "http://127.0.0.1:31337";

describe("ElizaClient packaged renderer auth", () => {
  beforeEach(() => {
    localStorage.clear();
    setBootConfig({ branding: {} });
    delete runtimeWindow.__ELIZA_ELECTROBUN_RPC__;
  });

  afterEach(() => {
    localStorage.clear();
    setBootConfig({ branding: {} });
    delete runtimeWindow.__ELIZA_ELECTROBUN_RPC__;
  });

  it("uses the current host token for the host-owned API base and follows rotation", () => {
    runtimeWindow.__ELIZA_ELECTROBUN_RPC__ = {
      request: {},
      onMessage: () => {},
      offMessage: () => {},
    };
    setBootConfig({
      branding: {},
      apiBase: LOCAL_BASE,
      apiToken: "host-generation-one",
    });
    const client = new ElizaClient(LOCAL_BASE, "stale-renderer-token");

    expect(client.apiToken).toBe("host-generation-one");

    // The preload updates this shared boot-config slot on apiBaseUpdate. The
    // client reads it lazily, so a supervised agent restart cannot strand the
    // still-mounted renderer on the prior generation's bearer.
    setBootConfig({
      branding: {},
      apiBase: LOCAL_BASE,
      apiToken: "host-generation-two",
    });
    expect(client.apiToken).toBe("host-generation-two");
  });

  it("preserves an explicit token outside the matching Electrobun host base", () => {
    runtimeWindow.__ELIZA_ELECTROBUN_RPC__ = {
      request: {},
      onMessage: () => {},
      offMessage: () => {},
    };
    setBootConfig({
      branding: {},
      apiBase: LOCAL_BASE,
      apiToken: "host-token",
    });
    const client = new ElizaClient(
      "https://agent.example.test",
      "selected-target-token",
    );

    expect(client.apiToken).toBe("selected-target-token");
  });

  it("does not let boot config override an ordinary web client's token", () => {
    setBootConfig({
      branding: {},
      apiBase: LOCAL_BASE,
      apiToken: "desktop-only-token",
    });
    const client = new ElizaClient(LOCAL_BASE, "web-token");

    expect(client.apiToken).toBe("web-token");
  });
});
