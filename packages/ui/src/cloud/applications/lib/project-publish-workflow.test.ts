/**
 * Project publication workflow tests the create→bind→deploy ordering and live
 * URL gate with deterministic Cloud/local boundary doubles.
 */

import { describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "../../../api/client-types-cloud";
import type { App } from "./apps";
import type { FrontendDeployment } from "./frontend-hosting";
import {
  type ProjectPublishDependencies,
  publishProject,
} from "./project-publish-workflow";

const PROJECT: ProjectSummary = {
  id: "project-1",
  name: "Habit Tracker",
  localPath: "/work/habit-tracker",
  repoUrl: "https://github.com/example/habit-tracker.git",
  defaultBranch: "main",
  lastOpenedAt: "2026-07-23T00:00:00.000Z",
};

function makeApp(overrides: Partial<App> = {}): App {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Habit Tracker",
    description: "Build better habits",
    slug: "habit-tracker",
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

function deployment(
  overrides: Partial<FrontendDeployment> = {},
): FrontendDeployment {
  return {
    id: "deployment-1",
    app_id: "11111111-1111-4111-8111-111111111111",
    version: 1,
    status: "active",
    file_count: 1,
    total_bytes: 42,
    build_meta: { source: "project-publish" },
    error: null,
    created_at: "2026-07-23T00:00:00.000Z",
    activated_at: "2026-07-23T00:00:01.000Z",
    finalized_at: "2026-07-23T00:00:01.000Z",
    ...overrides,
  };
}

function dependencies(
  calls: string[],
  overrides: Partial<ProjectPublishDependencies> = {},
): ProjectPublishDependencies {
  const createdApp = makeApp();
  const liveApp = makeApp({
    app_url: "https://habit-tracker.sites.elizacloud.ai",
    allowed_origins: ["https://habit-tracker.sites.elizacloud.ai"],
  });
  return {
    createCloudApp: vi.fn(async () => {
      calls.push("create");
      return { app: createdApp, apiKey: "eliza_once" };
    }),
    bindProject: vi.fn(async (_projectId, cloudAppId) => {
      calls.push("bind");
      return { ...PROJECT, cloudAppId };
    }),
    publishFrontend: vi.fn(async () => {
      calls.push("publish");
      return {
        deployment: deployment(),
        public_url: "https://habit-tracker.sites.elizacloud.ai",
      };
    }),
    deployContainer: vi.fn(async () => {
      calls.push("deploy-container");
      return {
        deploymentId: "container-deployment",
        status: "BUILDING" as const,
      };
    }),
    waitForContainer: vi.fn(async () => {
      calls.push("wait-container");
      return makeApp({
        deployment_status: "deployed",
        production_url: "https://abc.apps.elizacloud.ai",
      });
    }),
    patchCloudApp: vi.fn(async () => {
      calls.push("patch");
    }),
    readCloudApp: vi.fn(async () => {
      calls.push("read");
      return liveApp;
    }),
    ...overrides,
  };
}

describe("publishProject", () => {
  it("binds a newly created record before the managed deployment begins", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);

    const result = await publishProject(
      {
        project: PROJECT,
        name: "Habit Tracker",
        description: "Build better habits",
        mode: "managed-frontend",
        frontendFiles: [{ path: "index.html", content: "<h1>Live</h1>" }],
      },
      deps,
    );

    expect(calls).toEqual([
      "create",
      "bind",
      "patch",
      "publish",
      "patch",
      "read",
    ]);
    expect(result.project.cloudAppId).toBe(result.app.id);
    expect(result.apiKey).toBe("eliza_once");
    expect(deps.patchCloudApp).toHaveBeenCalledWith(
      result.app.id,
      expect.objectContaining({
        app_url: "https://habit-tracker.sites.elizacloud.ai",
        allowed_origins: ["https://habit-tracker.sites.elizacloud.ai"],
        is_active: true,
      }),
    );
    expect(deps.patchCloudApp).toHaveBeenNthCalledWith(1, result.app.id, {
      is_active: false,
    });
  });

  it("reuses an existing binding instead of creating a duplicate Cloud record", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    const existingApp = makeApp();

    await publishProject(
      {
        project: { ...PROJECT, cloudAppId: existingApp.id },
        existingApp,
        name: existingApp.name,
        description: existingApp.description ?? "",
        mode: "managed-frontend",
        frontendFiles: [{ path: "index.html", content: "ready" }],
      },
      deps,
    );

    expect(calls).toEqual(["patch", "publish", "patch", "read"]);
    expect(deps.createCloudApp).not.toHaveBeenCalled();
    expect(deps.bindProject).not.toHaveBeenCalled();
  });

  it("keeps the immediate binding observable when hosting has no public URL", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls, {
      publishFrontend: vi.fn(async () => {
        calls.push("publish");
        return { deployment: deployment(), public_url: null };
      }),
    });

    await expect(
      publishProject(
        {
          project: PROJECT,
          name: PROJECT.name,
          description: "",
          mode: "managed-frontend",
          frontendFiles: [{ path: "index.html", content: "ready" }],
        },
        deps,
      ),
    ).rejects.toThrow("no active public URL");

    expect(calls).toEqual(["create", "bind", "patch", "publish"]);
    expect(deps.patchCloudApp).toHaveBeenCalledOnce();
    expect(deps.patchCloudApp).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { is_active: false },
    );
  });

  it("retries a failed first deployment with the immediately bound Cloud record", async () => {
    const calls: string[] = [];
    let attempts = 0;
    let retryProject = PROJECT;
    let retryApp: App | undefined;
    const deps = dependencies(calls, {
      publishFrontend: vi.fn(async () => {
        attempts += 1;
        calls.push("publish");
        if (attempts === 1) throw new Error("upload interrupted");
        return {
          deployment: deployment(),
          public_url: "https://habit-tracker.sites.elizacloud.ai",
        };
      }),
    });
    const onBound = vi.fn((binding: { project: ProjectSummary; app: App }) => {
      retryProject = binding.project;
      retryApp = binding.app;
    });

    await expect(
      publishProject(
        {
          project: PROJECT,
          onBound,
          name: PROJECT.name,
          description: "",
          mode: "managed-frontend",
          frontendFiles: [{ path: "index.html", content: "ready" }],
        },
        deps,
      ),
    ).rejects.toThrow("upload interrupted");

    await publishProject(
      {
        project: retryProject,
        existingApp: retryApp,
        name: PROJECT.name,
        description: "",
        mode: "managed-frontend",
        frontendFiles: [{ path: "index.html", content: "ready" }],
      },
      deps,
    );

    expect(onBound).toHaveBeenCalledOnce();
    expect(deps.createCloudApp).toHaveBeenCalledOnce();
    expect(deps.bindProject).toHaveBeenCalledOnce();
    expect(attempts).toBe(2);
  });

  it("waits for a container production URL before patching publication metadata", async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);

    const result = await publishProject(
      {
        project: PROJECT,
        name: PROJECT.name,
        description: "",
        mode: "container",
        container: {
          repoUrl: "https://github.com/example/habit-tracker.git",
          ref: "0123456789abcdef0123456789abcdef01234567",
        },
      },
      deps,
    );

    expect(calls).toEqual([
      "create",
      "bind",
      "patch",
      "deploy-container",
      "wait-container",
      "patch",
      "read",
    ]);
    expect(result.publicUrl).toBe("https://abc.apps.elizacloud.ai");
  });
});
