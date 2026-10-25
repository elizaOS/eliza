/**
 * Remote app deploy e2e (#9145).
 *
 * Drives the real cloud-api deploy route against the mock-backed apps worker:
 * create a local/draft app, POST /deploy, tick the DB-backed APP_DEPLOY worker,
 * poll /deploy/status to READY, and fetch the resulting production_url.
 */

import {
  type AppDeploymentStatus,
  appKindFor,
} from "@elizaos/cloud-shared/lib/services/app-deployments-helpers";
import { authedClient } from "../src/helpers/monetization";
import { expect, test } from "../src/helpers/test-fixtures";

test.use({ stackOptions: { frontend: false } });

interface AppSummary {
  id: string;
  app_url: string;
  allowed_origins: string[];
  deployment_status: AppDeploymentStatus;
  production_url: string | null;
}

interface AppEnvelope {
  success?: boolean;
  app?: AppSummary;
  apiKey?: string;
}

interface DeployEnvelope {
  success?: boolean;
  deploymentId?: string | null;
  status?: "BUILDING" | "READY" | "ERROR" | "DRAFT";
  vercelUrl?: string | null;
  error?: string | null;
  startedAt?: string | null;
}

interface MockAppEnvelope {
  success?: boolean;
  appId?: string;
  containerId?: string;
  status?: string;
  runtime?: string;
}

test.describe("remote app deploy", () => {
  test("dashboard deploy endpoint reaches READY with a reachable production_url and preserved local definition", async ({
    stack,
    seededUser,
  }) => {
    const c = authedClient(stack.urls.api, seededUser.apiKey);
    const localAppUrl = "https://local-app.example.test";
    const allowedOrigins = [localAppUrl, "https://mobile.example.test"];

    const created = await c<AppEnvelope>("POST", "/api/v1/apps", {
      name: `Remote Deploy ${Date.now().toString(36)}`,
      app_url: localAppUrl,
      allowed_origins: allowedOrigins,
      skipGitHubRepo: true,
    });

    expect([200, 201]).toContain(created.status);
    const app = created.json.app;
    expect(app?.id, "apps.create must return an app id").toBeTruthy();
    if (!app?.id) throw new Error("apps.create did not return an app id");

    expect(appKindFor(app)).toBe("local");
    expect(app.production_url).toBeNull();
    expect(app.app_url).toBe(localAppUrl);
    expect(app.allowed_origins).toEqual(allowedOrigins);

    const started = await c<DeployEnvelope>(
      "POST",
      `/api/v1/apps/${app.id}/deploy`,
    );
    expect(started.status).toBe(202);
    expect(started.json.status).toBe("BUILDING");
    expect(started.json.deploymentId).toBeTruthy();

    let latest: DeployEnvelope | undefined;
    for (let i = 0; i < 20; i++) {
      const processed = await stack.mocks.controlPlane.processDbBackedJobs(
        stack.urls.pglite,
      );
      expect(processed.failed, JSON.stringify(processed.errors)).toBe(0);

      const status = await c<DeployEnvelope>(
        "GET",
        `/api/v1/apps/${app.id}/deploy/status`,
      );
      expect(status.status).toBe(200);
      latest = status.json;
      if (latest.status === "READY") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(latest?.status).toBe("READY");
    const productionUrl = latest?.vercelUrl;
    expect(
      productionUrl,
      "deploy status should expose production_url",
    ).toBeTruthy();
    if (!productionUrl)
      throw new Error("deploy status did not return production_url");

    const deployed = await c<AppEnvelope>("GET", `/api/v1/apps/${app.id}`);
    expect(deployed.status).toBe(200);
    expect(deployed.json.app?.deployment_status).toBe("deployed");
    expect(deployed.json.app?.production_url).toBe(productionUrl);
    expect(deployed.json.app && appKindFor(deployed.json.app)).toBe("remote");

    // Local-vs-remote parity: deploying creates a remote runtime, but the local
    // app definition the client authored remains stable.
    expect(deployed.json.app?.app_url).toBe(localAppUrl);
    expect(deployed.json.app?.allowed_origins).toEqual(allowedOrigins);

    const live = await fetch(productionUrl);
    expect(live.status).toBe(200);
    const liveJson = (await live.json()) as MockAppEnvelope;
    expect(liveJson).toMatchObject({
      success: true,
      appId: app.id,
      runtime: "mock-app-container",
    });
  });
});
