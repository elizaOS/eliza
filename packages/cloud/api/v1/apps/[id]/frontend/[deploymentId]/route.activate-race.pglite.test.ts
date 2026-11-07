/**
 * Deleting an old frontend deployment while the same deployment is being
 * activated (rollback) must never leave the app without a live deployment.
 * Real delete route, real hosting service and repository over PGlite; auth,
 * the app lookup and the app-key scope check are stubbed. The second writer
 * runs right after the first one has read the deployment.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import * as realAuth from "@elizaos/cloud-shared/auth";
import * as realAppKeyScope from "@elizaos/cloud-shared/lib/auth/app-key-scope";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const ORG = "44444444-4444-4444-8444-444444444444";
const APP = "11111111-1111-4111-8111-111111111111";
const LIVE = "22222222-2222-4222-8222-222222222222";
const OLD = "33333333-3333-4333-8333-333333333333";

mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: ORG,
  }),
}));
mock.module("@elizaos/cloud-shared/lib/auth/app-key-scope", () => ({
  ...realAppKeyScope,
  isAppKeyOutOfScope: async () => false,
}));

const { closeDatabaseConnectionsForTests, dbWrite } = await import(
  "@elizaos/cloud-shared/db/client"
);
const { appFrontendDeployments } = await import(
  "@elizaos/cloud-shared/db/schemas"
);
const { appFrontendDeploymentsRepository } = await import(
  "@elizaos/cloud-shared/db/repositories/app-frontend-deployments"
);
const { appFrontendHostingService } = await import(
  "@elizaos/cloud-shared/lib/services/app-frontend-hosting"
);
const { appsService } = await import("@elizaos/cloud-shared/lib/services/apps");
const { default: deploymentRoute }: { default: Hono<AppEnv> } = await import(
  "./route"
);

const app = new Hono<AppEnv>();
app.route("/api/v1/apps/:id/frontend/:deploymentId", deploymentRoute);

const deleteOld = () =>
  app.request(`/api/v1/apps/${APP}/frontend/${OLD}`, { method: "DELETE" });

/** Runs `other` once, right after the next deployment read. */
function afterNextRead(other: () => Promise<unknown>) {
  const original = appFrontendDeploymentsRepository.getByIdForApp.bind(
    appFrontendDeploymentsRepository,
  );
  let pending: (() => Promise<unknown>) | null = other;
  return spyOn(
    appFrontendDeploymentsRepository,
    "getByIdForApp",
  ).mockImplementation(async (appId, id) => {
    const row = await original(appId, id);
    const run = pending;
    pending = null;
    if (run) await run();
    return row;
  });
}

beforeAll(async () => {
  spyOn(appsService, "getById").mockResolvedValue({
    id: APP,
    organization_id: ORG,
  } as never);
  const config = getTableConfig(appFrontendDeployments);
  await dbWrite.execute(
    sql.raw(
      `CREATE TABLE ${config.name} (${config.columns
        .map(
          (column) =>
            `"${column.name}" ${column.getSQLType()}${column.name === "id" ? " PRIMARY KEY" : ""}`,
        )
        .join(",")})`,
    ),
  );
});

beforeEach(async () => {
  await dbWrite.execute(sql.raw("TRUNCATE TABLE app_frontend_deployments"));
  await dbWrite.execute(
    sql.raw(`INSERT INTO app_frontend_deployments (id, app_id, version, status, r2_prefix, created_at, updated_at)
      VALUES ('${LIVE}', '${APP}', 2, 'active', 'p/', now(), now()),
             ('${OLD}', '${APP}', 1, 'superseded', 'p/', now(), now())`),
  );
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

test("a rollback that lands during a delete keeps the rolled-back deployment live", async () => {
  const spy = afterNextRead(() => appFrontendHostingService.activate(APP, OLD));
  let status = 0;
  try {
    status = (await deleteOld()).status;
  } finally {
    spy.mockRestore();
  }

  expect(status).toBe(409);
  expect((await appFrontendDeploymentsRepository.getActive(APP))?.id).toBe(OLD);
});

test("a delete that lands during a rollback leaves the current deployment live", async () => {
  const spy = afterNextRead(async () => deleteOld());
  let activated: unknown;
  try {
    activated = await appFrontendHostingService.activate(APP, OLD);
  } finally {
    spy.mockRestore();
  }

  expect(activated).toBeUndefined();
  expect((await appFrontendDeploymentsRepository.getActive(APP))?.id).toBe(
    LIVE,
  );
});
