import { describe, expect, test } from "bun:test";
import {
  buildCaddyAddRouteUrl,
  buildCaddyRoute,
  buildCaddyRouteByIdUrl,
  buildCaddyRouteId,
  buildOnDemandAskUrl,
} from "../apps-ingress-routes";

const HOST = "abc12345.apps.elizacloud.ai";

describe("buildCaddyRouteId", () => {
  test("derives a stable id from the host's first label (the shortid)", () => {
    expect(buildCaddyRouteId(HOST)).toBe("app-abc12345");
  });
  test("sanitizes to [a-z0-9] and lowercases", () => {
    expect(buildCaddyRouteId("AbC-1.apps.elizacloud.ai")).toBe("app-abc1");
  });
});

describe("buildCaddyRoute", () => {
  test("host-match -> reverse_proxy to nodeHost:hostPort, keyed by @id", () => {
    expect(buildCaddyRoute({ hostname: HOST, nodeHost: "10.30.1.5", hostPort: 28123 })).toEqual({
      "@id": "app-abc12345",
      match: [{ host: ["abc12345.apps.elizacloud.ai"] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "10.30.1.5:28123" }] }],
    });
  });
});

describe("admin-API urls", () => {
  test("add-route URL targets a server's routes (default srv0)", () => {
    expect(buildCaddyAddRouteUrl("http://127.0.0.1:2019")).toBe(
      "http://127.0.0.1:2019/config/apps/http/servers/srv0/routes",
    );
    expect(buildCaddyAddRouteUrl("http://127.0.0.1:2019/", "ingress")).toBe(
      "http://127.0.0.1:2019/config/apps/http/servers/ingress/routes",
    );
  });
  test("by-id URL addresses the route by @id (for DELETE)", () => {
    expect(buildCaddyRouteByIdUrl("http://127.0.0.1:2019", "app-abc12345")).toBe(
      "http://127.0.0.1:2019/id/app-abc12345",
    );
  });
});

describe("buildOnDemandAskUrl", () => {
  test("points at the fixed apps-ingress ask endpoint (Caddy appends ?domain=)", () => {
    expect(buildOnDemandAskUrl("https://api.elizacloud.ai/")).toBe(
      "https://api.elizacloud.ai/api/v1/apps-ingress/ask",
    );
  });
});
