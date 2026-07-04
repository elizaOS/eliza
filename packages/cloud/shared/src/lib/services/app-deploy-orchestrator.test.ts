// Exercises app deploy orchestrator behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import { type AppDeployDeps, deployApp, type NewAppContainerRow } from "./app-deploy-orchestrator";

function makeDeps(): { deps: AppDeployDeps; captured: { row?: NewAppContainerRow } } {
  const captured: { row?: NewAppContainerRow } = {};
  const deps: AppDeployDeps = {
    ensureTenantDb: async () => "postgres://tenant-dsn/app",
    createContainerRow: async (row) => {
      captured.row = row;
      return { containerId: "container-1" };
    },
    enqueueProvision: async () => ({ id: "job-1" }),
    linkContainerToApp: async () => {},
  };
  return { deps, captured };
}

const baseReq = {
  appId: "app-1",
  organizationId: "org-1",
  userId: "user-1",
  containerName: "my-app",
  image: "ghcr.io/elizaos/app:1.0.0",
} as const;

describe("deployApp env hardening", () => {
  test("strips caller-supplied platform-reserved keys on a stateless (none) app", async () => {
    const { deps, captured } = makeDeps();
    await deployApp(
      {
        ...baseReq,
        databaseMode: "none",
        env: {
          DATABASE_URL: "postgres://attacker/db",
          POSTGRES_URL: "postgres://attacker/db",
          ELIZAOS_CLOUD_API_KEY: "stolen-token",
          ELIZA_API_TOKEN: "stolen",
          APP_SETTING: "keep-me",
        },
      },
      deps,
    );
    // Reserved keys stripped; a stateless app gets NO DB var injected and can no
    // longer smuggle one (or a managed identity key) in via caller env. The app
    // id is platform-owned and injected from the deploy request.
    expect(captured.row?.environmentVars).toEqual({
      APP_SETTING: "keep-me",
      ELIZA_APP_ID: baseReq.appId,
    });
  });

  test("platform isolated DSN wins over caller DATABASE_URL/POSTGRES_URL", async () => {
    const { deps, captured } = makeDeps();
    await deployApp(
      {
        ...baseReq,
        databaseMode: "isolated",
        env: {
          DATABASE_URL: "postgres://attacker/db",
          POSTGRES_URL: "postgres://attacker/db",
          KEEP: "1",
        },
      },
      deps,
    );
    expect(captured.row?.environmentVars).toEqual({
      KEEP: "1",
      ELIZA_APP_ID: baseReq.appId,
      DATABASE_URL: "postgres://tenant-dsn/app",
      POSTGRES_URL: "postgres://tenant-dsn/app",
    });
  });

  test("non-reserved caller env passes through unchanged", async () => {
    const { deps, captured } = makeDeps();
    await deployApp(
      {
        ...baseReq,
        databaseMode: "none",
        env: { FOO: "bar", ELIZA_APP_ID: "spoofed-app", LOG_LEVEL: "debug" },
      },
      deps,
    );
    expect(captured.row?.environmentVars).toEqual({
      FOO: "bar",
      ELIZA_APP_ID: baseReq.appId,
      LOG_LEVEL: "debug",
    });
  });
});
