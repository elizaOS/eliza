/**
 * Real-staging EDAD deploy-and-serve driver (#9300, slice 1).
 *
 * The mock showcase loop (`example-apps-showcase.spec.ts`) proves the whole
 * register -> deploy -> subdomain -> monetize -> earn chain against an in-process
 * mock stack, but it can never prove the ONE thing only live infra can: that a
 * real container deploy actually SERVES its `*.apps.elizacloud.ai` subdomain over
 * real ingress/TLS. This spec fills that seam (showcase-apps-coverage.md step 3)
 * with a single, honest-skip, pure-HTTP driver:
 *
 *   1. auth preflight    GET /api/v1/credits/balance -> 200 (the operator-
 *                        provisioned showcase org + grant exist on staging).
 *   2. register EDAD     POST /api/v1/apps (the EDAD descriptor reused from the
 *                        mock spec's SHOWCASE_APPS) -> an app id.
 *   3. deploy            POST /api/v1/apps/:id/deploy with repo/ref/Dockerfile
 *                        build hints -> 202 BUILDING. The normal app deploy
 *                        backend builds the image from source, then runs it in
 *                        an app container.
 *   4. poll              GET /api/v1/apps/:id/deploy/status until READY — real
 *                        cadence ~5s, ~10min cap (per the status-route docstring).
 *                        NO control-plane mock tick: live cloud-api runs its own
 *                        APP_DEPLOY worker. On ERROR it fails loud.
 *   5. assert it SERVES  GET /api/v1/apps/:id -> deployment_status "deployed",
 *                        production_url set, appKindFor(app) "remote". Then
 *                        fetch(production_url) -> 200 and EDAD's own /api/config
 *                        self-report (cloud_url present — NOT the mock
 *                        runtime:"mock-app-container"); the subdomain host ends
 *                        `.apps.elizacloud.ai` and the ingress on-demand-TLS gate
 *                        GET /api/v1/apps-ingress/ask?domain=<host> authorizes it.
 *   6. teardown          DELETE /api/v1/apps/:id (full cleanup deprovisions the
 *                        container) in a finally, so a real run leaves NO orphan
 *                        billable resources.
 *
 * It runs ONLY under MONETIZED_LOOP_REAL=1 + a base URL + a showcase key — i.e.
 * the nightly `loop` job (monetized-loop-nightly.yml), where the mock showcase
 * spec skips ITSELF. Per-PR / mock-nightly CI never sets those, so this spec
 * honest-skips at the describe level (before any fixture resolves) and never
 * touches live staging. It is complementary to the mock spec — zero change there.
 */

import {
  type AppDeploymentStatus,
  appKindFor,
} from "@elizaos/cloud-shared/lib/services/app-deployments-helpers";
import type { CreditBalanceResponse } from "@elizaos/cloud-shared/lib/types/cloud-api";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import { authedClient } from "../src/helpers/monetization";
import { expect, test } from "../src/helpers/test-fixtures";

/** The apps data-plane base domain on real staging (CONTAINERS_PUBLIC_BASE_DOMAIN). */
const APPS_BASE_DOMAIN = "apps.elizacloud.ai";

/** Default staging cloud-api base URL when MONETIZED_LOOP_BASE_URL is unset. */
const DEFAULT_BASE_URL = "https://api-staging.elizacloud.ai";

/** A sane credit floor: the showcase org carries an effectively-infinite grant. */
const MIN_SHOWCASE_BALANCE_USD = 1;

/** Real deploy: poll every ~5s, cap ~10 min (per the deploy/status docstring). */
const POLL_INTERVAL_MS = 5_000;
const POLL_CAP_MS = 10 * 60_000;
const SHOWCASE_REPO_URL =
  process.env.SHOWCASE_APPS_REPO_URL ?? "https://github.com/elizaOS/eliza.git";
const SHOWCASE_REF =
  process.env.SHOWCASE_APPS_REF ?? process.env.GITHUB_SHA ?? "develop";

/**
 * EDAD's descriptor — the same one the mock spec drives via SHOWCASE_APPS.
 * `appUrl` is the local definition the app authored; the live runtime URL is the
 * deploy-stamped `production_url`, asserted in step 5.
 */
const EDAD = {
  key: "edad",
  name: "eDad Showcase",
  appUrl: "https://edad.example",
  repoUrl: SHOWCASE_REPO_URL,
  ref: SHOWCASE_REF,
  dockerfile: "packages/examples/cloud/edad/Dockerfile.cloud",
} as const;

/** apps.create / apps.get envelope (see cloud-api .../apps/route.ts). */
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
}

/** apps.deploy / deploy-status envelope (see .../apps/[id]/deploy/route.ts). */
interface DeployEnvelope {
  success?: boolean;
  deploymentId?: string | null;
  status?: "BUILDING" | "READY" | "ERROR" | "DRAFT";
  vercelUrl?: string | null;
  error?: string | null;
  startedAt?: string | null;
}

/** EDAD's own /api/config self-report (packages/examples/cloud/edad/server.ts). */
interface EdadConfigResponse {
  app_id?: string | null;
  cloud_url?: string;
  affiliate_code?: string | null;
  db_enabled?: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

test.describe("real-staging EDAD deploy serves its subdomain (#9300)", () => {
  // Honest-skip gate FIRST — evaluated before any fixture resolves, so the mock
  // `stack` is never booted. Per-PR / mock CI leaves these unset, so this whole
  // describe skips and CANNOT reach live staging. Only the nightly `loop` job
  // (MONETIZED_LOOP_REAL=1 + operator-provisioned base URL + showcase key) runs it.
  test.skip(
    process.env.MONETIZED_LOOP_REAL !== "1" ||
      !process.env.MONETIZED_LOOP_BASE_URL ||
      !process.env.CLOUD_E2E_API_KEY,
    "real-staging EDAD driver: needs MONETIZED_LOOP_REAL=1 + MONETIZED_LOOP_BASE_URL + CLOUD_E2E_API_KEY (operator-provisioned showcase account)",
  );

  test("real EDAD deploy serves its subdomain", async () => {
    // A real container build + deploy poll runs well past the 2-min default.
    test.setTimeout(POLL_CAP_MS + 120_000);

    const api = (
      process.env.MONETIZED_LOOP_BASE_URL ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
    // The describe-level skip guarantees the key is present in real mode.
    const apiKey = process.env.CLOUD_E2E_API_KEY;
    if (!apiKey)
      throw new Error("CLOUD_E2E_API_KEY missing despite real-mode gate");
    const authed = authedClient(api, apiKey);

    // ── 1. auth preflight: the showcase org + its grant exist on staging. ─────
    const balance = await authed<CreditBalanceResponse>(
      "GET",
      "/api/v1/credits/balance",
    );
    expect(
      balance.status,
      "showcase key authenticates against staging (login works)",
    ).toBe(200);
    expect(
      balance.json.balance,
      "showcase org is funded (operator grant present)",
    ).toBeGreaterThanOrEqual(MIN_SHOWCASE_BALANCE_USD);

    let appId: string | undefined;
    try {
      // ── 2. register EDAD (pure HTTP — no metadata write). ───────────────────
      const created = await authed<AppEnvelope>("POST", "/api/v1/apps", {
        name: `${EDAD.name} ${Date.now().toString(36)}`,
        app_url: EDAD.appUrl,
        allowed_origins: [EDAD.appUrl],
        skipGitHubRepo: true,
      });
      expect([200, 201], "EDAD registers on staging").toContain(created.status);
      appId = created.json.app?.id;
      expect(appId, "apps.create returns an app id").toBeTruthy();
      if (!appId) throw new Error("apps.create did not return an app id");
      logger.info("[edad-real] registered app", { appId, api });

      // ── 3. deploy through the REAL route — source build, no image map. ──────
      const started = await authed<DeployEnvelope>(
        "POST",
        `/api/v1/apps/${appId}/deploy`,
        {
          repoUrl: EDAD.repoUrl,
          ref: EDAD.ref,
          dockerfile: EDAD.dockerfile,
          env: { ELIZA_APP_ID: appId },
        },
      );
      expect(started.status, "deploy accepted (202)").toBe(202);
      expect(started.json.status, "deploy starts BUILDING").toBe("BUILDING");
      expect(
        started.json.deploymentId,
        "deploy returns a deployment id",
      ).toBeTruthy();
      logger.info("[edad-real] deploy queued", {
        appId,
        deploymentId: started.json.deploymentId,
      });

      // ── 4. poll the live APP_DEPLOY worker to READY (no mock tick). ─────────
      const deadline = Date.now() + POLL_CAP_MS;
      let latest: DeployEnvelope | undefined;
      while (Date.now() < deadline) {
        const status = await authed<DeployEnvelope>(
          "GET",
          `/api/v1/apps/${appId}/deploy/status`,
        );
        expect(status.status, "deploy status reachable").toBe(200);
        latest = status.json;
        if (latest.status === "READY") break;
        if (latest.status === "ERROR") {
          throw new Error(
            `staging deploy failed: ${latest.error ?? "unknown error"}`,
          );
        }
        await sleep(POLL_INTERVAL_MS);
      }
      expect(latest?.status, "deploy reaches READY within the cap").toBe(
        "READY",
      );
      const statusUrl = latest?.vercelUrl;
      expect(statusUrl, "deploy status exposes a production_url").toBeTruthy();
      logger.info("[edad-real] deploy READY", {
        appId,
        productionUrl: statusUrl,
      });

      // ── 5a. the app row reflects a deployed REMOTE runtime. ────────────────
      const deployed = await authed<AppEnvelope>(
        "GET",
        `/api/v1/apps/${appId}`,
      );
      expect(deployed.status, "deployed app readable").toBe(200);
      const deployedApp = deployed.json.app;
      expect(deployedApp?.deployment_status, "app is deployed").toBe(
        "deployed",
      );
      const productionUrl = deployedApp?.production_url;
      expect(productionUrl, "app row stamps a production_url").toBeTruthy();
      if (!productionUrl) throw new Error("deployed app has no production_url");
      // appKindFor takes the deployment-state fields; the app summary carries them.
      expect(
        deployedApp && appKindFor(deployedApp),
        "deployed EDAD is a remote app",
      ).toBe("remote");

      // ── 5b. the subdomain lives on the apps data plane. ────────────────────
      // In real mode the host IS the server-stamped production_url (deriveAppPublicUrl
      // ran operator-side at deploy time); we read it back over HTTP, never the DB.
      const host = new URL(productionUrl).hostname;
      expect(
        host.endsWith(`.${APPS_BASE_DOMAIN}`),
        `production subdomain is on the apps data plane (got ${host})`,
      ).toBe(true);

      // ── 5c. the deployed URL actually SERVES — the real EDAD container. ────
      const live = await fetch(productionUrl);
      expect(live.status, "deployed production_url serves (200)").toBe(200);

      // EDAD's own /api/config self-report proves it is the real container, not
      // the mock's runtime:"mock-app-container". cloud_url is wired by the image.
      const configRes = await fetch(
        new URL("/api/config", productionUrl).toString(),
      );
      expect(
        configRes.status,
        "EDAD /api/config self-report serves (200)",
      ).toBe(200);
      const config = (await configRes.json()) as EdadConfigResponse;
      expect(config.app_id, "EDAD self-reports the deployed app id").toBe(
        appId,
      );
      expect(
        typeof config.cloud_url === "string" && config.cloud_url.length > 0,
        "EDAD self-reports its cloud_url (real container, not the mock)",
      ).toBe(true);
      expect(
        typeof config.db_enabled === "boolean",
        "EDAD self-reports db state (its real config shape)",
      ).toBe(true);

      // ── 5d. ingress on-demand-TLS gate authorizes the live app host. ───────
      const ask = await fetch(
        `${api}/api/v1/apps-ingress/ask?domain=${encodeURIComponent(host)}`,
      );
      expect(
        ask.status,
        "ingress authorizes a TLS cert for the live app subdomain",
      ).toBe(200);

      logger.info("[edad-real] EDAD serves its subdomain", { appId, host });
    } finally {
      // ── 6. guaranteed teardown — leave no orphan billable resources. ───────
      // DELETE runs full cleanup (deprovisions the container/node) server-side.
      if (appId) {
        const deleted = await authed("DELETE", `/api/v1/apps/${appId}`);
        if (deleted.status !== 200) {
          logger.error("[edad-real] teardown DELETE non-200", {
            appId,
            status: deleted.status,
          });
        } else {
          logger.info("[edad-real] torn down", { appId });
        }
      }
    }
  });
});
