// Exercises app deploy orchestrator behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import {
  type AppDeployDeps,
  type DeployAppRequest,
  deployApp,
  type NewAppContainerRow,
} from "../app-deploy-orchestrator";

const REQ: DeployAppRequest = {
  appId: "11111111-2222-3333-4444-555555555555",
  organizationId: "org-1",
  userId: "user-1",
  containerName: "app-nubilio",
  image: "ghcr.io/nubs/nubilio:latest",
};

// An app that opted into its OWN isolated per-tenant DB.
const REQ_ISOLATED: DeployAppRequest = { ...REQ, databaseMode: "isolated" };

const TENANT_DSN = "postgresql://app_x:pw@apps-cluster-1/db_app_x?sslmode=require";

function deps(over: Partial<AppDeployDeps> = {}) {
  const seen: {
    row?: NewAppContainerRow;
    enqueued?: { containerId: string };
    linked?: { appId: string; containerId: string };
  } = {};
  const base: AppDeployDeps = {
    async ensureTenantDb() {
      return TENANT_DSN;
    },
    async createContainerRow(row) {
      seen.row = row;
      return { containerId: "container-1" };
    },
    async enqueueProvision(p) {
      seen.enqueued = { containerId: p.containerId };
      return { id: "job-1" };
    },
    async linkContainerToApp(appId, containerId) {
      seen.linked = { appId, containerId };
    },
  };
  return { seen, deps: { ...base, ...over } };
}

describe("deployApp", () => {
  test("provisions an isolated DB, creates the row with that DSN, enqueues, links", async () => {
    const { seen, deps: d } = deps();
    const result = await deployApp(REQ_ISOLATED, d);

    expect(result).toEqual({ containerId: "container-1", jobId: "job-1" });
    // the container row carries the app's OWN per-tenant DSN under BOTH vars
    // (DATABASE_URL standard + POSTGRES_URL for plugin-sql/eliza images)
    expect(seen.row?.environmentVars.DATABASE_URL).toBe(TENANT_DSN);
    expect(seen.row?.environmentVars.POSTGRES_URL).toBe(TENANT_DSN);
    expect(seen.row?.environmentVars.ELIZA_APP_ID).toBe(REQ.appId);
    expect(seen.row?.image).toBe(REQ.image);
    expect(seen.row?.port).toBe(3000);
    // provision was enqueued for the created container
    expect(seen.enqueued?.containerId).toBe("container-1");
    // container linked back to the app
    expect(seen.linked).toEqual({ appId: REQ.appId, containerId: "container-1" });
  });

  test("the injected DSN is the per-tenant one, never a shared agent URL", async () => {
    const { seen, deps: d } = deps({
      async ensureTenantDb() {
        return TENANT_DSN;
      },
    });
    await deployApp(REQ_ISOLATED, d);
    expect(seen.row?.environmentVars.DATABASE_URL).not.toContain("agentdb");
    expect(seen.row?.environmentVars.DATABASE_URL).toContain("db_app_x");
    // POSTGRES_URL mirrors it exactly — same isolated DB, never the agent URL
    expect(seen.row?.environmentVars.POSTGRES_URL).not.toContain("agentdb");
    expect(seen.row?.environmentVars.POSTGRES_URL).toContain("db_app_x");
  });

  test("honors a custom container port", async () => {
    const { seen, deps: d } = deps();
    await deployApp({ ...REQ, port: 8080 }, d);
    expect(seen.row?.port).toBe(8080);
  });

  test("injects platform-owned app id into a stateless app container", async () => {
    const { seen, deps: d } = deps();
    await deployApp(
      {
        ...REQ,
        env: {
          ELIZA_APP_ID: "spoofed-app",
          ELIZA_CLOUD_URL: "https://www.elizacloud.ai",
        },
      },
      d,
    );
    expect(seen.row?.environmentVars).toEqual({
      ELIZA_APP_ID: REQ.appId,
      ELIZA_CLOUD_URL: "https://www.elizacloud.ai",
    });
  });

  test("platform DB env wins over caller-provided DB keys", async () => {
    const { seen, deps: d } = deps();
    await deployApp(
      {
        ...REQ_ISOLATED,
        env: {
          DATABASE_URL: "postgresql://not-the-tenant-db",
          POSTGRES_URL: "postgresql://also-not-the-tenant-db",
          ELIZA_APP_ID: "spoofed-app",
        },
      },
      d,
    );
    expect(seen.row?.environmentVars).toEqual({
      DATABASE_URL: TENANT_DSN,
      POSTGRES_URL: TENANT_DSN,
      ELIZA_APP_ID: REQ.appId,
    });
  });

  test("surfaces a DB-provisioning failure before creating any container", async () => {
    let created = false;
    const { deps: d } = deps({
      async ensureTenantDb() {
        throw new Error("No tenant DB cluster has capacity");
      },
      async createContainerRow(row) {
        created = true;
        return { containerId: "x" };
      },
    });
    await expect(deployApp(REQ_ISOLATED, d)).rejects.toThrow("capacity");
    expect(created).toBe(false);
  });

  test("a stateless app (mode 'none', the default) provisions NO DB and injects no DATABASE_URL", async () => {
    let ensureCalled = false;
    const { seen, deps: d } = deps({
      async ensureTenantDb() {
        ensureCalled = true;
        return TENANT_DSN;
      },
    });
    // REQ has no databaseMode -> defaults to "none"
    const result = await deployApp(REQ, d);

    expect(ensureCalled).toBe(false); // the tenant-DB cluster is never touched
    expect(seen.row?.environmentVars.DATABASE_URL).toBeUndefined();
    expect(seen.row?.environmentVars.POSTGRES_URL).toBeUndefined();
    expect(seen.row?.environmentVars).toEqual({ ELIZA_APP_ID: REQ.appId });
    // everything else still happens — the app deploys + runs, just without a DB
    expect(result).toEqual({ containerId: "container-1", jobId: "job-1" });
    expect(seen.enqueued?.containerId).toBe("container-1");
    expect(seen.linked).toEqual({ appId: REQ.appId, containerId: "container-1" });
  });

  test("explicit mode 'none' behaves like the default (no DB)", async () => {
    let ensureCalled = false;
    const { seen, deps: d } = deps({
      async ensureTenantDb() {
        ensureCalled = true;
        return TENANT_DSN;
      },
    });
    await deployApp({ ...REQ, databaseMode: "none" }, d);
    expect(ensureCalled).toBe(false);
    expect(seen.row?.environmentVars).toEqual({ ELIZA_APP_ID: REQ.appId });
  });
});
