/**
 * App-factory TEMPLATE-IMAGE wiring (the launch blocker).
 *
 * The apps-deploy access gate is open in prod, but a real user's create -> deploy
 * FAILED because a template app (one created WITHOUT a user repo, i.e.
 * `createGitHubRepo: false` / `skipGitHubRepo: true` — the path the agent's
 * CREATE_APP uses) had no image: build-from-repo is intentionally OFF, so the
 * deploy runner's `resolveImageRef` threw "no image to deploy".
 *
 * The fix stamps a first-party, allowlisted template image as
 * `app.metadata.imageTag` at create time. These tests prove:
 *   - a template app gets the default first-party image stamped (and persisted),
 *   - the default is env-overridable (`APP_DEFAULT_TEMPLATE_IMAGE`),
 *   - a caller-supplied image wins and a pre-existing imageTag is never overwritten,
 *   - a REPO-BACKED app is left unchanged (no image stamped),
 *   - and end-to-end: the stamped app then RESOLVES an image through the real
 *     `resolveImageRef` (does not throw), while a repo-backed app still
 *     (correctly) throws build-from-repo-disabled.
 *
 * `../apps` + `../github-repos` are mocked so the factory runs without a DB; the
 * template-image logic, the real `containersEnv.appDefaultTemplateImage()`, and
 * the real `resolveImageRef` gate are all exercised for real.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const updateCalls: Array<{ id: string; updates: Record<string, unknown> }> = [];
// Per-test seed for what appsService.create() returns as the new app's metadata
// (lets one test simulate an app whose metadata already carries an imageTag).
let seededMetadata: Record<string, unknown> = {};

class FakeAppNameConflictError extends Error {
  readonly conflictType = "app";
}

mock.module("../apps", () => ({
  AppNameConflictError: FakeAppNameConflictError,
  appsService: {
    isNameAvailable: async () => ({ available: true }),
    create: async (data: {
      name: string;
      organization_id: string;
      created_by_user_id: string;
      app_url: string;
    }) => ({
      app: {
        id: "11111111-2222-3333-4444-555555555555",
        slug: "demo-app",
        name: data.name,
        organization_id: data.organization_id,
        created_by_user_id: data.created_by_user_id,
        app_url: data.app_url,
        github_repo: null,
        metadata: { ...seededMetadata },
      },
      apiKey: "eliza_test_app_key",
    }),
    update: async (id: string, updates: Record<string, unknown>) => {
      updateCalls.push({ id, updates });
      return undefined;
    },
  },
}));

mock.module("../github-repos", () => ({
  githubReposService: {
    generateRepoName: (_id: string, slug: string) => `app-${slug}`,
    createAppRepo: async ({ name }: { name: string }) => ({ fullName: `elizaOS-apps/${name}` }),
  },
}));

import type { AppDeployRunnerDeps } from "../app-deploy-runner";
import { resolveImageRef } from "../app-deploy-runner";
import { appFactoryService } from "../app-factory";

const DATA = {
  name: "Demo App",
  organization_id: "org-1",
  created_by_user_id: "user-1",
  app_url: "https://demo.example.com",
};

const DEFAULT_TEMPLATE_IMAGE = "ghcr.io/elizaos/example-edad:showcase";
const buildOff = { resolveImage: undefined } as unknown as AppDeployRunnerDeps;

function metaImageTag(metadata: unknown): string | undefined {
  const m = (metadata as Record<string, unknown>) ?? {};
  return typeof m.imageTag === "string" ? m.imageTag : undefined;
}

beforeEach(() => {
  updateCalls.length = 0;
  seededMetadata = {};
});

afterEach(() => {
  delete process.env.APP_DEFAULT_TEMPLATE_IMAGE;
  delete process.env.APPS_DEPLOY_IMAGE_ALLOWLIST;
});

describe("createApp: template-image wiring (no-repo apps)", () => {
  test("template app (createGitHubRepo:false) stamps the default first-party image + persists it", async () => {
    const result = await appFactoryService.createApp(DATA, { createGitHubRepo: false });

    expect(result.githubRepoCreated).toBe(false);
    expect(result.githubRepo).toBeUndefined();
    // Stamped on the returned app...
    expect(metaImageTag(result.app.metadata)).toBe(DEFAULT_TEMPLATE_IMAGE);
    // ...and persisted via appsService.update(metadata).
    const persisted = updateCalls.at(-1);
    expect(persisted?.id).toBe(result.app.id);
    expect(metaImageTag(persisted?.updates.metadata)).toBe(DEFAULT_TEMPLATE_IMAGE);
  });

  test("APP_DEFAULT_TEMPLATE_IMAGE env overrides the stamped image", async () => {
    process.env.APP_DEFAULT_TEMPLATE_IMAGE = "ghcr.io/elizaos/example-clone-ur-crush:showcase";
    const result = await appFactoryService.createApp(DATA, { createGitHubRepo: false });
    expect(metaImageTag(result.app.metadata)).toBe(
      "ghcr.io/elizaos/example-clone-ur-crush:showcase",
    );
  });

  test("caller-supplied options.imageTag wins over the default (not overwritten)", async () => {
    const result = await appFactoryService.createApp(DATA, {
      createGitHubRepo: false,
      imageTag: "ghcr.io/elizaos/myapp:v9",
    });
    expect(metaImageTag(result.app.metadata)).toBe("ghcr.io/elizaos/myapp:v9");
  });

  test("a pre-existing metadata.imageTag is never overwritten (no redundant update)", async () => {
    seededMetadata = { imageTag: "ghcr.io/elizaos/preexisting:v1" };
    const result = await appFactoryService.createApp(DATA, { createGitHubRepo: false });
    expect(metaImageTag(result.app.metadata)).toBe("ghcr.io/elizaos/preexisting:v1");
    // imageTag unchanged => no metadata write (and no repo => no github_repo write).
    expect(updateCalls.length).toBe(0);
  });

  test("repo-backed app (default createGitHubRepo) is NOT stamped with an image", async () => {
    const result = await appFactoryService.createApp(DATA);
    expect(result.githubRepoCreated).toBe(true);
    expect(result.githubRepo).toBe("elizaOS-apps/app-demo-app");
    expect(metaImageTag(result.app.metadata)).toBeUndefined();
    // The only persisted update is the github_repo, never an imageTag.
    for (const call of updateCalls) {
      expect("imageTag" in ((call.updates.metadata as Record<string, unknown>) ?? {})).toBe(false);
    }
  });
});

describe("create -> deploy linkage: resolveImageRef on the created app", () => {
  test("the stamped template app RESOLVES its image (does NOT throw)", async () => {
    const result = await appFactoryService.createApp(DATA, { createGitHubRepo: false });
    const img = await resolveImageRef(buildOff, {
      id: result.app.id,
      name: result.app.name,
      metadata: (result.app.metadata as Record<string, unknown>) ?? {},
      repoUrl: result.app.github_repo ?? undefined,
    });
    expect(img).toBe(DEFAULT_TEMPLATE_IMAGE);
  });

  test("a repo-backed app still throws build-from-repo-disabled (unchanged)", async () => {
    const result = await appFactoryService.createApp(DATA);
    await expect(
      resolveImageRef(buildOff, {
        id: result.app.id,
        name: result.app.name,
        metadata: (result.app.metadata as Record<string, unknown>) ?? {},
        repoUrl: result.app.github_repo ?? undefined,
      }),
    ).rejects.toThrow(/build-from-repo is disabled/);
  });
});

/**
 * FRONT-DOOR end-to-end: prove that a real create request body — exactly what
 * the agent CREATE_APP action and the dashboard Create App dialog now POST to
 * `POST /api/v1/apps` — flows through the server route's `createGitHubRepo:
 * skipGitHubRepo === false` mapping, the real factory, and the real `resolveImageRef`
 * to a deployable image (does NOT throw). `skipGitHubRepo: false` remains the
 * explicit repo-backed opt-in path and still throws under the build-from-repo
 * disabled gate.
 */
describe("front-door create -> deploy resolves (POST /api/v1/apps body)", () => {
  // Mirrors the server route (`packages/cloud/api/v1/apps/route.ts`): the create
  // route only provisions a GitHub repo when the request explicitly opts in with
  // `skipGitHubRepo: false`. Keep this in lockstep with the route.
  const createFromFrontDoorBody = (body: {
    name: string;
    app_url: string;
    skipGitHubRepo?: boolean;
  }) =>
    appFactoryService.createApp(
      {
        name: body.name,
        organization_id: DATA.organization_id,
        created_by_user_id: DATA.created_by_user_id,
        app_url: body.app_url,
      },
      { createGitHubRepo: body.skipGitHubRepo === false },
    );

  test("the fixed front-door body (skipGitHubRepo:true) stamps a template image and RESOLVES", async () => {
    // The exact body the front doors send: a draft-sentinel URL + skipGitHubRepo.
    const result = await createFromFrontDoorBody({
      name: "Acme Bot",
      app_url: "https://placeholder.invalid",
      skipGitHubRepo: true,
    });

    // No repo was created, and a deployable template image was stamped.
    expect(result.githubRepoCreated).toBe(false);
    expect(metaImageTag(result.app.metadata)).toBe(DEFAULT_TEMPLATE_IMAGE);

    // The created app RESOLVES an image through the real deploy-runner gate —
    // the create -> deploy loop the audit found broken now completes.
    const img = await resolveImageRef(buildOff, {
      id: result.app.id,
      name: result.app.name,
      metadata: (result.app.metadata as Record<string, unknown>) ?? {},
      repoUrl: result.app.github_repo ?? undefined,
    });
    expect(img).toBe(DEFAULT_TEMPLATE_IMAGE);
  });

  test("default raw create body (no skipGitHubRepo) stamps a template image and RESOLVES", async () => {
    const result = await createFromFrontDoorBody({
      name: "Acme Bot",
      app_url: "https://placeholder.invalid",
      // skipGitHubRepo omitted — raw API default must not provision a repo.
    });

    expect(result.githubRepoCreated).toBe(false);
    expect(metaImageTag(result.app.metadata)).toBe(DEFAULT_TEMPLATE_IMAGE);

    const img = await resolveImageRef(buildOff, {
      id: result.app.id,
      name: result.app.name,
      metadata: (result.app.metadata as Record<string, unknown>) ?? {},
      repoUrl: result.app.github_repo ?? undefined,
    });
    expect(img).toBe(DEFAULT_TEMPLATE_IMAGE);
  });

  test("explicit repo opt-in (skipGitHubRepo:false) makes a repo app whose deploy THROWS while build-from-repo is disabled", async () => {
    const result = await createFromFrontDoorBody({
      name: "Repo Bot",
      app_url: "https://placeholder.invalid",
      skipGitHubRepo: false,
    });

    expect(result.githubRepoCreated).toBe(true);
    expect(metaImageTag(result.app.metadata)).toBeUndefined();

    await expect(
      resolveImageRef(buildOff, {
        id: result.app.id,
        name: result.app.name,
        metadata: (result.app.metadata as Record<string, unknown>) ?? {},
        repoUrl: result.app.github_repo ?? undefined,
      }),
    ).rejects.toThrow(/build-from-repo is disabled/);
  });
});
