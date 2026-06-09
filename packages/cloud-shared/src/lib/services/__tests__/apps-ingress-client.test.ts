import { describe, expect, test } from "bun:test";
import {
  buildCaddyAdminLoadUrl,
  buildIngressMapUrl,
  buildRemoteIngressSyncShell,
  countIngressHosts,
  readAppsIngressSyncConfig,
  resolveAppsIngressNodeHostnames,
} from "../apps-ingress-client";

describe("apps-ingress-client", () => {
  test("buildIngressMapUrl targets the caddy format", () => {
    expect(buildIngressMapUrl("https://api.elizacloud.ai/")).toBe(
      "https://api.elizacloud.ai/api/v1/admin/containers/ingress-map?format=caddy",
    );
  });

  test("buildCaddyAdminLoadUrl normalizes trailing slashes", () => {
    expect(buildCaddyAdminLoadUrl("http://127.0.0.1:2019/")).toBe(
      "http://127.0.0.1:2019/load",
    );
  });

  test("countIngressHosts counts site blocks", () => {
    const snippet = [
      "abc123.apps.elizacloud.ai {",
      "  reverse_proxy http://10.0.0.1:49001",
      "}",
      "",
      "def456.apps.elizacloud.ai {",
      "  reverse_proxy http://10.0.0.1:49002",
      "}",
    ].join("\n");
    expect(countIngressHosts(snippet)).toBe(2);
  });

  test("readAppsIngressSyncConfig returns null when disabled", () => {
    expect(readAppsIngressSyncConfig({ APPS_INGRESS_SYNC_ENABLED: "0" })).toBeNull();
  });

  test("readAppsIngressSyncConfig reads origin + key when enabled", () => {
    const config = readAppsIngressSyncConfig({
      APPS_INGRESS_SYNC_ENABLED: "1",
      APPS_INGRESS_API_ORIGIN: "https://api.example.test",
      APPS_INGRESS_ADMIN_API_KEY: "eliza_test",
      APPS_CADDY_ADMIN_URL: "http://127.0.0.1:2019",
    });
    expect(config).toMatchObject({
      apiOrigin: "https://api.example.test",
      adminApiKey: "eliza_test",
      caddyAdminUrl: "http://127.0.0.1:2019",
    });
  });

  test("resolveAppsIngressNodeHostnames prefers APPS_INGRESS_NODE_HOSTS", () => {
    const hosts = resolveAppsIngressNodeHostnames({
      APPS_INGRESS_NODE_HOSTS: "10.30.1.20,10.30.1.21",
      CONTAINERS_DOCKER_NODES: "ignored:1.2.3.4:8",
    });
    expect(hosts).toEqual(["10.30.1.20", "10.30.1.21"]);
  });

  test("buildRemoteIngressSyncShell writes snippet and reloads caddy", () => {
    const shell = buildRemoteIngressSyncShell({
      snippetBase64: "YWJj",
      snippetPath: "/etc/caddy/apps.d/ingress-map.caddy",
      caddyfilePath: "/etc/caddy/Caddyfile",
      caddyAdminUrl: "http://127.0.0.1:2019",
    });
    expect(shell).toContain("base64 -d");
    expect(shell).toContain("/etc/caddy/apps.d/ingress-map.caddy");
    expect(shell).toContain("http://127.0.0.1:2019/load");
    expect(shell).toContain("/etc/caddy/Caddyfile");
  });
});
