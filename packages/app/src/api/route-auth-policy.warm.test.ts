import { beforeEach, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ session: vi.fn(), owner: vi.fn() }));
vi.mock("./auth.ts", () => ({
  ensureRouteAuthorized: auth.session,
  ensureRouteMinRole: auth.owner,
}));

import {
  enforceCompatRouteAuthPolicy,
  resolveCompatRouteAuthPolicy,
} from "./route-auth-policy.ts";

type RouteArgs = Parameters<typeof enforceCompatRouteAuthPolicy>;
beforeEach(() => {
  vi.clearAllMocks();
});
function response() {
  return {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
    headersSent: false,
  } as unknown as RouteArgs[1];
}
it("declares warm POST with ordinary session authority", () => {
  expect(resolveCompatRouteAuthPolicy("POST", "/api/cloud/warm")).toMatchObject(
    { id: "cloud.warm", tier: "session" },
  );
});
it("delegates valid paired-owner warm requests to the established session gate", async () => {
  const req = {
      headers: { authorization: "Bearer paired-owner" },
      method: "POST",
      url: "/api/cloud/warm",
    } as unknown as RouteArgs[0],
    res = response(),
    state = {} as RouteArgs[2];
  auth.session.mockResolvedValue(true);
  expect(
    await enforceCompatRouteAuthPolicy(
      req,
      res,
      state,
      "POST",
      "/api/cloud/warm",
    ),
  ).toBe("allowed");
  expect(auth.session).toHaveBeenCalledExactlyOnceWith(req, res, state);
  expect(auth.owner).not.toHaveBeenCalled();
});
it("never turns rejected session authority into warm access", async () => {
  auth.session.mockResolvedValue(false);
  expect(
    await enforceCompatRouteAuthPolicy(
      { headers: {} } as RouteArgs[0],
      response(),
      {} as RouteArgs[2],
      "POST",
      "/api/cloud/warm",
    ),
  ).toBe("denied");
  expect(auth.session).toHaveBeenCalledOnce();
});
it.each(["GET", "PUT", "DELETE"])(
  "keeps unsupported warm method %s denied",
  async (method) => {
    const res = response();
    expect(
      await enforceCompatRouteAuthPolicy(
        { headers: {} } as RouteArgs[0],
        res,
        {} as RouteArgs[2],
        method,
        "/api/cloud/warm",
      ),
    ).toBe("denied");
    expect(res.statusCode).toBe(401);
    expect(auth.session).not.toHaveBeenCalled();
  },
);
it("keeps undeclared cloud routes denied", async () => {
  const res = response();
  expect(
    await enforceCompatRouteAuthPolicy(
      { headers: {} } as RouteArgs[0],
      res,
      {} as RouteArgs[2],
      "POST",
      "/api/cloud/warm-extra",
    ),
  ).toBe("denied");
  expect(res.statusCode).toBe(401);
});
