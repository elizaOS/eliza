import assert from "node:assert/strict";
import { it } from "vitest";
import * as hostApi from "./http-plugin-runtime.js";

it("registers routes explicitly and rejects public writes before changing host state", () => {
  const host = {};
  hostApi.registerHttpPluginRoutes(host, {
    name: "fixture",
    description: "HTTP fixture",
    routes: [{ type: "GET", path: "/health" }],
  });
  assert.equal(
    hostApi.getPluginHttpRoutes(host, "fixture")[0].path,
    "/fixture/health",
  );
  assert.throws(
    () =>
      hostApi.registerHttpPluginRoutes(host, {
        name: "unsafe",
        description: "Invalid public write",
        routes: [
          {
            type: "POST",
            path: "/write",
            public: true,
            publicReason: "fixture",
          },
        ],
      }),
    /publicWrite/,
  );
  assert.equal(
    hostApi.getHttpRuntime(host).routes.length,
    1,
    "rejected routes do not alter host state",
  );
});
