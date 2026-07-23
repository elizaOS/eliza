/**
 * Publication join tests distinguish truly live managed/container deployments
 * from bound-but-unpublished records without a React or router harness.
 */

import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api-client";
import type { App } from "./apps";
import type { FrontendDeploymentsList } from "./frontend-hosting";
import {
  isStaleProjectBindingError,
  loadProjectPublication,
  type ProjectPublicationDependencies,
} from "./project-publication";

function makeApp(overrides: Partial<App> = {}): App {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Project",
    description: null,
    slug: "project",
    organization_id: "org-1",
    created_by_user_id: "user-1",
    app_url: "https://pending.invalid",
    allowed_origins: ["https://pending.invalid"],
    api_key_id: null,
    affiliate_code: null,
    referral_bonus_credits: "0.00",
    total_requests: 0,
    total_users: 0,
    total_credits_used: "0.00",
    logo_url: null,
    website_url: null,
    contact_email: null,
    metadata: {},
    deployment_status: "draft",
    production_url: null,
    last_deployed_at: null,
    github_repo: null,
    linked_character_ids: [],
    monetization_enabled: false,
    inference_markup_percentage: 0,
    purchase_share_percentage: 0,
    platform_offset_amount: 0,
    custom_pricing_enabled: false,
    total_creator_earnings: "0.00",
    total_platform_revenue: "0.00",
    discord_automation: null,
    telegram_automation: null,
    twitter_automation: null,
    promotional_assets: null,
    user_database_status: "none",
    user_database_uri: null,
    user_database_region: null,
    user_database_error: null,
    email_notifications: true,
    response_notifications: true,
    is_active: true,
    is_approved: true,
    review_status: "draft",
    review_content_hash: null,
    reviewed_at: null,
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:00.000Z",
    last_used_at: null,
    ...overrides,
  };
}

function frontend(
  overrides: Partial<FrontendDeploymentsList> = {},
): FrontendDeploymentsList {
  const activeId = overrides.active_deployment_id ?? null;
  return {
    active_deployment_id: activeId,
    public_url: "https://project.sites.elizacloud.ai",
    deployments: activeId
      ? [
          {
            id: activeId,
            app_id: "11111111-1111-4111-8111-111111111111",
            version: 1,
            status: "active",
            file_count: 1,
            total_bytes: 42,
            build_meta: {},
            error: null,
            created_at: "2026-07-23T00:00:00.000Z",
            activated_at: "2026-07-23T00:00:00.000Z",
            finalized_at: "2026-07-23T00:00:00.000Z",
          },
        ]
      : [],
    ...overrides,
  };
}

function dependencies(
  app: App,
  hosting: FrontendDeploymentsList,
): ProjectPublicationDependencies {
  return {
    readApp: async () => app,
    listFrontend: async () => hosting,
  };
}

describe("loadProjectPublication", () => {
  it("requires an active deployment and authoritative system URL for managed publication", async () => {
    const app = makeApp();
    await expect(
      loadProjectPublication(
        app.id,
        dependencies(app, frontend({ active_deployment_id: "deployment-1" })),
      ),
    ).resolves.toMatchObject({
      status: "published",
      liveMode: "managed-frontend",
      publicUrl: "https://project.sites.elizacloud.ai",
    });

    const unavailable = await loadProjectPublication(
      app.id,
      dependencies(
        app,
        frontend({
          active_deployment_id: "deployment-1",
          public_url: null,
        }),
      ),
    );
    expect(unavailable.status).toBe("error");
    expect(unavailable.liveMode).toBeUndefined();

    const mismatched = await loadProjectPublication(
      app.id,
      dependencies(
        app,
        frontend({
          active_deployment_id: "deployment-1",
          deployments: [],
        }),
      ),
    );
    expect(mismatched.status).toBe("error");
    expect(mismatched.liveMode).toBeUndefined();
  });

  it("recognizes a ready container only with its production URL", async () => {
    const app = makeApp({
      deployment_status: "deployed",
      production_url: "https://abc.apps.elizacloud.ai",
    });
    await expect(
      loadProjectPublication(app.id, dependencies(app, frontend())),
    ).resolves.toMatchObject({
      status: "published",
      liveMode: "container",
      publicUrl: "https://abc.apps.elizacloud.ai",
    });
  });

  it("recognizes an intentionally external active publication by app_url", async () => {
    const app = makeApp({
      app_url: "https://external.example.com/product",
      deployment_status: "draft",
      production_url: null,
    });

    await expect(
      loadProjectPublication(app.id, dependencies(app, frontend())),
    ).resolves.toMatchObject({
      status: "published",
      liveMode: "external",
      publicUrl: "https://external.example.com/product",
    });
  });

  it("does not relabel a stale managed URL as an external publication", async () => {
    const managedUrl = "https://project.sites.elizacloud.ai";
    const app = makeApp({ app_url: managedUrl });

    const result = await loadProjectPublication(
      app.id,
      dependencies(
        app,
        frontend({
          active_deployment_id: "missing-deployment",
          public_url: managedUrl,
          deployments: [],
        }),
      ),
    );

    expect(result.status).toBe("error");
    expect(result.liveMode).toBeUndefined();
  });

  it("does not relabel a regressed container URL as an external publication", async () => {
    const containerUrl = "https://project.apps.elizacloud.ai";
    const app = makeApp({
      app_url: containerUrl,
      production_url: containerUrl,
      deployment_status: "failed",
    });

    const result = await loadProjectPublication(
      app.id,
      dependencies(app, frontend({ public_url: null })),
    );

    expect(result.status).toBe("error");
    expect(result.liveMode).toBeUndefined();
  });

  it("keeps an inactive app unpublished while retaining its management data", async () => {
    const app = makeApp({ is_active: false });
    const result = await loadProjectPublication(
      app.id,
      dependencies(app, frontend({ active_deployment_id: "deployment-1" })),
    );
    expect(result).toMatchObject({
      status: "unpublished",
      liveMode: "managed-frontend",
      app,
    });
  });

  it("propagates Cloud read failures for the hook to render as error state", async () => {
    const failure = new Error("Cloud transport unavailable");
    await expect(
      loadProjectPublication("app-1", {
        readApp: async () => {
          throw failure;
        },
        listFrontend: async () => frontend(),
      }),
    ).rejects.toBe(failure);
  });

  it("never exposes placeholder URLs for an inactive bound record", async () => {
    const result = await loadProjectPublication(
      "app-1",
      dependencies(
        makeApp({ is_active: false }),
        frontend({ public_url: null }),
      ),
    );

    expect(result).toMatchObject({ status: "unpublished" });
    expect(result.publicUrl).toBeUndefined();
  });

  it("allows stale-binding recovery only for a definite Cloud 404", () => {
    expect(
      isStaleProjectBindingError(
        new ApiError(404, "not_found", "Cloud app not found"),
      ),
    ).toBe(true);
    expect(
      isStaleProjectBindingError(
        new ApiError(503, "unavailable", "Cloud unavailable"),
      ),
    ).toBe(false);
    expect(isStaleProjectBindingError(new Error("network failed"))).toBe(false);
  });
});
