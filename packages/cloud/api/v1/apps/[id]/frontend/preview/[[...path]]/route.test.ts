/**
 * The owner preview serves uploaded HTML from the Cloud API origin, which the
 * web app shares through its same-origin `/api/*` proxy. The page must run in
 * an opaque sandbox origin so its scripts cannot read the viewer's session.
 */
import { afterAll, expect, mock, spyOn, test } from "bun:test";

const ORG = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";

const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: ORG,
  }),
}));
const realScope = {
  ...(await import("@elizaos/cloud-shared/lib/auth/app-key-scope")),
};
mock.module("@elizaos/cloud-shared/lib/auth/app-key-scope", () => ({
  ...realScope,
  isAppKeyOutOfScope: async () => false,
}));

const { appsService } = await import("@elizaos/cloud-shared/lib/services/apps");
const { appFrontendDeploymentsRepository } = await import(
  "@elizaos/cloud-shared/db/repositories/app-frontend-deployments"
);
const { appFrontendHostingService } = await import(
  "@elizaos/cloud-shared/lib/services/app-frontend-hosting"
);
const { Hono } = await import("hono");
const { default: previewRoute } = await import("./route");

const spies = [
  spyOn(appsService, "getById").mockResolvedValue({
    id: APP,
    organization_id: ORG,
    name: "Preview app",
    description: null,
    logo_url: null,
    production_url: null,
    app_url: null,
  } as never),
  spyOn(appFrontendDeploymentsRepository, "getActive").mockResolvedValue({
    id: "deployment-1",
  } as never),
  spyOn(appFrontendHostingService, "renderFrontendResponse").mockResolvedValue({
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    },
    body: "<script>localStorage.getItem('steward_session_token')</script>",
    isDocument: false,
  } as never),
];

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  mock.restore();
});

const app = new Hono().route("/api/v1/apps/:id/frontend/preview", previewRoute);

test("the preview runs uploaded HTML in an opaque sandbox origin and is not cached", async () => {
  const response = await app.request(`/api/v1/apps/${APP}/frontend/preview/`);
  expect(response.status).toBe(200);
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp.startsWith("sandbox")).toBe(true);
  expect(csp).toContain("allow-scripts");
  expect(csp).not.toContain("allow-same-origin");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
