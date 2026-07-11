/**
 * Real-staging Clone Ur Crush deploy-and-serve driver (#9300, slice 1 - parity
 * with example-edad-real-deploy.spec.ts).
 *
 * The mock showcase loop (`example-apps-showcase.spec.ts`) proves the whole
 * register -> deploy -> subdomain -> monetize -> earn chain for BOTH apps against
 * an in-process mock stack, but it can never prove the one thing only live infra
 * can: that a real container deploy actually SERVES its `*.apps.elizacloud.ai`
 * subdomain over real ingress/TLS. EDAD has such a driver; this is the matching
 * one for Clone Ur Crush so BOTH flagship apps are validated on live infra.
 *
 * It is a single, honest-skip, pure-HTTP driver:
 *   1. auth preflight    GET /api/v1/credits/balance -> 200 (operator-provisioned
 *                        funded showcase org exists on staging).
 *   2. register          POST /api/v1/apps -> an app id.
 *   3. deploy            POST /api/v1/apps/:id/deploy with repo/ref/Dockerfile
 *                        build hints -> 202 BUILDING. The normal app deploy
 *                        backend builds Clone Ur Crush from source, then runs it
 *                        in an app container.
 *   4. poll              GET /api/v1/apps/:id/deploy/status until READY (real ~5s
 *                        cadence, ~10min cap; no mock control-plane tick).
 *   5. assert it SERVES  the deployed *.apps.elizacloud.ai production_url returns
 *                        200, its HTML carries Clone Ur Crush's own wordmark
 *                        ("Clone Your Crush") - NOT the mock runtime - and a real
 *                        /_next/static chunk serves 200 (the Next standalone
 *                        static path is intact; this is what catches the broken
 *                        distDir/static bug class), and the ingress on-demand-TLS
 *                        `ask` gate authorizes the live host.
 *   6. teardown          DELETE /api/v1/apps/:id in a finally - no orphan billable
 *                        container.
 *
 * Runs ONLY under MONETIZED_LOOP_REAL=1 + base URL + showcase key (the nightly
 * `loop` job). Per-PR / mock CI never sets those, so this honest-skips at the
 * describe level (before any fixture resolves) and never touches live staging.
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

/** Clone Ur Crush's descriptor for the normal source-build deploy path. */
const CUC = {
  name: "Clone Your Crush Showcase",
  appUrl: "https://clone-ur-crush.example",
  repoUrl: SHOWCASE_REPO_URL,
  ref: SHOWCASE_REF,
  dockerfile: "packages/examples/cloud/clone-ur-crush/Dockerfile.cloud",
} as const;

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
interface DeployEnvelope {
  success?: boolean;
  deploymentId?: string | null;
  status?: "BUILDING" | "READY" | "ERROR" | "DRAFT";
  vercelUrl?: string | null;
  error?: string | null;
  startedAt?: string | null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

test.describe("real-staging Clone Ur Crush deploy serves its subdomain (#9300)", () => {
  // Honest-skip gate FIRST - evaluated before any fixture resolves, so the mock
  // `stack` is never booted. Per-PR / mock CI leaves these unset.
  test.skip(
    process.env.MONETIZED_LOOP_REAL !== "1" ||
      !process.env.MONETIZED_LOOP_BASE_URL ||
      !process.env.CLOUD_E2E_API_KEY,
    "real-staging Clone Ur Crush driver: needs MONETIZED_LOOP_REAL=1 + " +
      "MONETIZED_LOOP_BASE_URL + CLOUD_E2E_API_KEY (operator-provisioned showcase " +
      "account) and the normal app deploy builder/daemon armed.",
  );

  test("real Clone Ur Crush deploy serves its subdomain", async () => {
    test.setTimeout(POLL_CAP_MS + 120_000);

    const api = (
      process.env.MONETIZED_LOOP_BASE_URL ?? DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
    const apiKey = process.env.CLOUD_E2E_API_KEY;
    if (!apiKey)
      throw new Error("CLOUD_E2E_API_KEY missing despite real-mode gate");
    const authed = authedClient(api, apiKey);

    // -- 1. auth preflight --------------------------------------------------
    const balance = await authed<CreditBalanceResponse>(
      "GET",
      "/api/v1/credits/balance",
    );
    expect(balance.status, "showcase key authenticates against staging").toBe(
      200,
    );
    expect(
      balance.json.balance,
      "showcase org is funded (operator grant present)",
    ).toBeGreaterThanOrEqual(MIN_SHOWCASE_BALANCE_USD);

    let appId: string | undefined;
    try {
      // -- 2. register ------------------------------------------------------
      const created = await authed<AppEnvelope>("POST", "/api/v1/apps", {
        name: `${CUC.name} ${Date.now().toString(36)}`,
        app_url: CUC.appUrl,
        allowed_origins: [CUC.appUrl],
        skipGitHubRepo: true,
      });
      expect([200, 201], "Clone Ur Crush registers on staging").toContain(
        created.status,
      );
      appId = created.json.app?.id;
      expect(appId, "apps.create returns an app id").toBeTruthy();
      if (!appId) throw new Error("apps.create did not return an app id");
      logger.info("[cuc-real] registered app", { appId, api });

      // -- 3. deploy through the REAL route - source build, no image map. ----
      const started = await authed<DeployEnvelope>(
        "POST",
        `/api/v1/apps/${appId}/deploy`,
        {
          repoUrl: CUC.repoUrl,
          ref: CUC.ref,
          dockerfile: CUC.dockerfile,
        },
      );
      expect(started.status, "deploy accepted (202)").toBe(202);
      expect(started.json.status, "deploy starts BUILDING").toBe("BUILDING");
      expect(
        started.json.deploymentId,
        "deploy returns a deployment id",
      ).toBeTruthy();

      // -- 4. poll the live APP_DEPLOY worker to READY (no mock tick). -------
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

      // -- 5a. the app row reflects a deployed REMOTE runtime. --------------
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
      expect(
        deployedApp && appKindFor(deployedApp),
        "deployed Clone Ur Crush is a remote app",
      ).toBe("remote");

      // -- 5b. the subdomain lives on the apps data plane. ------------------
      const host = new URL(productionUrl).hostname;
      expect(
        host.endsWith(`.${APPS_BASE_DOMAIN}`),
        `production subdomain is on the apps data plane (got ${host})`,
      ).toBe(true);

      // -- 5c. it SERVES the REAL Clone Ur Crush container (its own UI). -----
      const live = await fetch(productionUrl);
      expect(live.status, "deployed production_url serves (200)").toBe(200);
      const html = await live.text();
      expect(
        html.includes("Clone Your Crush"),
        "serves the real Clone Ur Crush UI (its wordmark), not the mock/EDAD image",
      ).toBe(true);

      // A real Next.js standalone static chunk must serve - catches the broken
      // distDir/static path bug class (HTML serves but every CSS/JS 404s).
      const assetPath = html.match(/\/_next\/static\/[^"']+\.(?:js|css)/)?.[0];
      expect(assetPath, "HTML references a /_next/static asset").toBeTruthy();
      if (assetPath) {
        const asset = await fetch(new URL(assetPath, productionUrl).toString());
        expect(
          asset.status,
          `Clone Ur Crush serves its /_next/static asset (${assetPath})`,
        ).toBe(200);
      }

      // -- 5d. ingress on-demand-TLS gate authorizes the live app host. -----
      const ask = await fetch(
        `${api}/api/v1/apps-ingress/ask?domain=${encodeURIComponent(host)}`,
      );
      expect(
        ask.status,
        "ingress authorizes a TLS cert for the live app subdomain",
      ).toBe(200);

      logger.info("[cuc-real] Clone Ur Crush serves its subdomain", {
        appId,
        host,
      });
    } finally {
      // -- 6. guaranteed teardown - leave no orphan billable resources. -----
      if (appId) {
        const deleted = await authed("DELETE", `/api/v1/apps/${appId}`);
        if (deleted.status !== 200) {
          logger.error("[cuc-real] teardown DELETE non-200", {
            appId,
            status: deleted.status,
          });
        } else {
          logger.info("[cuc-real] torn down", { appId });
        }
      }
    }
  });
});
