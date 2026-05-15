import { describe, expect, test } from "bun:test";
import { ensureServerName, getAdvertisedServerUrl, normalizeServerName } from "../../src/config";

describe("normalizeServerName", () => {
  test("normalizes Railway-style service names for Redis keys and DNS-safe identifiers", () => {
    expect(normalizeServerName(" Agent Server ")).toBe("agent-server");
    expect(normalizeServerName("agent_server.prod")).toBe("agent-server-prod");
  });

  test("returns undefined for blank or non-alphanumeric names", () => {
    expect(normalizeServerName("")).toBeUndefined();
    expect(normalizeServerName(" -- ")).toBeUndefined();
  });
});

describe("ensureServerName", () => {
  test("keeps an explicit SERVER_NAME", () => {
    const env = { SERVER_NAME: "shared-eliza", RAILWAY_SERVICE_NAME: "Agent Server" };

    expect(ensureServerName(env)).toBe("shared-eliza");
    expect(env.SERVER_NAME).toBe("shared-eliza");
  });

  test("derives SERVER_NAME from Railway service metadata", () => {
    const env = { RAILWAY_SERVICE_NAME: "Agent Server" };

    expect(ensureServerName(env)).toBe("agent-server");
    expect(env.SERVER_NAME).toBe("agent-server");
  });

  test("falls back to Railway service id when service name is unavailable", () => {
    const env = { RAILWAY_SERVICE_ID: "8baf830a-2dc3-465d-b7ed-725fae3eaa56" };

    expect(ensureServerName(env)).toBe("8baf830a-2dc3-465d-b7ed-725fae3eaa56");
    expect(env.SERVER_NAME).toBe("8baf830a-2dc3-465d-b7ed-725fae3eaa56");
  });
});

describe("getAdvertisedServerUrl", () => {
  test("prefers an explicit AGENT_SERVER_URL", () => {
    expect(getAdvertisedServerUrl({ AGENT_SERVER_URL: "https://agent.example.com/" })).toBe(
      "https://agent.example.com",
    );
  });

  test("uses Railway private networking when available", () => {
    expect(
      getAdvertisedServerUrl({
        RAILWAY_PRIVATE_DOMAIN: "agent-server.railway.internal",
        PORT: "3000",
      }),
    ).toBe("http://agent-server.railway.internal:3000");
  });

  test("falls back to Railway public domain when private networking is unavailable", () => {
    expect(getAdvertisedServerUrl({ RAILWAY_PUBLIC_DOMAIN: "agent-server.up.railway.app" })).toBe(
      "https://agent-server.up.railway.app",
    );
  });

  test("uses the Kubernetes service address outside Railway", () => {
    expect(getAdvertisedServerUrl({ SERVER_NAME: "shared-eliza" })).toBe(
      "http://shared-eliza.eliza-agents.svc:3000",
    );
    expect(
      getAdvertisedServerUrl({ SERVER_NAME: "shared-eliza", POD_NAMESPACE: "custom-ns" }),
    ).toBe("http://shared-eliza.custom-ns.svc:3000");
  });
});
