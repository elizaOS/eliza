// Exercises apps ingress routes behavior with deterministic cloud-shared lib fixtures.
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
  test("host-match -> reverse_proxy to the node-local 127.0.0.1:hostPort, keyed by @id", () => {
    // Caddy is co-located on the app node and the container publishes only to
    // loopback, so the dial is always 127.0.0.1 (NOT the private-network node IP)
    // — this is what makes the published port unreachable across tenants.
    expect(buildCaddyRoute({ hostname: HOST, hostPort: 28123 })).toEqual({
      "@id": "app-abc12345",
      match: [{ host: ["abc12345.apps.elizacloud.ai"] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:28123" }] }],
    });
  });

  test("folds verified custom domains into the same route's host-match (deduped + lowercased)", () => {
    const route = buildCaddyRoute({
      hostname: HOST,
      extraHostnames: ["Elocute.fun", "www.elocute.fun", "elocute.fun", "   "],
      hostPort: 28123,
    });
    // @id stays keyed off the wildcard host, so one DELETE tears down all hosts
    expect(route["@id"]).toBe("app-abc12345");
    expect(route.match).toEqual([
      { host: ["abc12345.apps.elizacloud.ai", "elocute.fun", "www.elocute.fun"] },
    ]);
    // host-match folds in the custom domains, but the dial stays loopback
    expect(route.handle[0].upstreams[0].dial).toBe("127.0.0.1:28123");
  });

  test("empty/omitted extraHostnames keeps the plain single-host route", () => {
    expect(buildCaddyRoute({ hostname: HOST, extraHostnames: [], hostPort: 1 }).match).toEqual([
      { host: ["abc12345.apps.elizacloud.ai"] },
    ]);
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
