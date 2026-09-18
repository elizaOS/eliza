/** Exercises the deployment use case with controlled database, job and container boundaries. */
import { describe, expect, test } from "bun:test";
import {
  type AppDeployDeps,
  type DeployAppRequest,
  deployApp,
  type NewAppContainerRow,
} from "./app-deploy-orchestrator";

const REQ: DeployAppRequest = {
  appId: "11111111-2222-3333-4444-555555555555",
  deploymentGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationId: "org-1",
  userId: "user-1",
  containerName: "app-nubilio",
  image: "ghcr.io/nubs/nubilio:latest",
};

const REQ_ISOLATED: DeployAppRequest = { ...REQ, databaseMode: "isolated" };

const TENANT_DSN = "postgresql://app_x:pw@apps-cluster-1/db_app_x?sslmode=require";

function deps(over: Partial<AppDeployDeps> = {}) {
  const seen: {
    row?: NewAppContainerRow;
    enqueued?: { containerId: string; deploymentGeneration: string };
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
      seen.enqueued = {
        containerId: p.containerId,
        deploymentGeneration: p.deploymentGeneration,
      };
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
    expect(seen.row?.environmentVars.DATABASE_URL).toBe(TENANT_DSN);
    expect(seen.row?.environmentVars.POSTGRES_URL).toBe(TENANT_DSN);
    expect(seen.row?.environmentVars.ELIZA_APP_ID).toBe(REQ.appId);
    expect(seen.row?.image).toBe(REQ.image);
    expect(seen.row?.port).toBe(3000);
    expect(seen.enqueued?.containerId).toBe("container-1");
    expect(seen.enqueued?.deploymentGeneration).toBe(REQ.deploymentGeneration);
    expect(seen.linked).toEqual({ appId: REQ.appId, containerId: "container-1" });
  });

  test("honors a custom container port", async () => {
    const { seen, deps: d } = deps();
    await deployApp({ ...REQ, port: 8080 }, d);
    expect(seen.row?.port).toBe(8080);
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
          KEEP: "1",
        },
      },
      d,
    );
    expect(seen.row?.environmentVars).toEqual({
      DATABASE_URL: TENANT_DSN,
      POSTGRES_URL: TENANT_DSN,
      ELIZA_APP_ID: REQ.appId,
      KEEP: "1",
    });
  });

  test("surfaces a DB-provisioning failure before creating any container", async () => {
    let created = false;
    const { deps: d } = deps({
      async ensureTenantDb() {
        throw new Error("No tenant DB cluster has capacity");
      },
      async createContainerRow() {
        created = true;
        return { containerId: "x" };
      },
    });
    await expect(deployApp(REQ_ISOLATED, d)).rejects.toThrow("capacity");
    expect(created).toBe(false);
  });

  test.each([undefined, "none"] as const)(
    "stateless mode %p skips DB provisioning and strips reserved caller env",
    async (databaseMode) => {
      let ensureCalled = false;
      const { seen, deps: d } = deps({
        async ensureTenantDb() {
          ensureCalled = true;
          return TENANT_DSN;
        },
      });
      const result = await deployApp(
        {
          ...REQ,
          databaseMode,
          env: {
            DATABASE_URL: "postgres://attacker/db",
            POSTGRES_URL: "postgres://attacker/db",
            ELIZAOS_CLOUD_API_KEY: "stolen-token",
            ELIZA_API_TOKEN: "stolen",
            ELIZA_APP_ID: "spoofed-app",
            APP_SETTING: "keep-me",
            ELIZA_CLOUD_URL: "https://www.elizacloud.ai",
          },
        },
        d,
      );

      expect(ensureCalled).toBe(false);
      expect(seen.row?.environmentVars).toEqual({
        ELIZA_APP_ID: REQ.appId,
        APP_SETTING: "keep-me",
        ELIZA_CLOUD_URL: "https://www.elizacloud.ai",
      });
      expect(result).toEqual({ containerId: "container-1", jobId: "job-1" });
      expect(seen.enqueued?.containerId).toBe("container-1");
      expect(seen.linked).toEqual({ appId: REQ.appId, containerId: "container-1" });
    },
  );
});
