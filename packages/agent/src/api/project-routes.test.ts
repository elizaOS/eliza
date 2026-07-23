/**
 * Verifies the project registry HTTP contract through injected route
 * collaborators and temporary on-disk registries. The filesystem cases protect
 * the strict-read invariant: missing state is empty, while malformed state must
 * surface as an error instead of being replaced with a healthy-looking list.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type http from "node:http";
import os from "node:os";
import { join } from "node:path";
import { readProjectRegistryOrThrow } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  handleProjectRoutes,
  type ProjectListDTO,
  type ProjectSummaryDTO,
} from "./project-routes.ts";

const res = {} as http.ServerResponse;

function makeHelpers() {
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn();
  return { json, error, readJsonBody };
}

function ctx(
  method: string,
  pathname: string,
  helpers: ReturnType<typeof makeHelpers>,
) {
  return {
    req: {} as http.IncomingMessage,
    res,
    method,
    pathname,
    json: helpers.json,
    error: helpers.error,
    readJsonBody: helpers.readJsonBody,
  };
}

const PROJECT_A: ProjectSummaryDTO = {
  id: "proj-a",
  name: "Alpha",
  localPath: "/home/dev/alpha",
  repoUrl: "https://github.com/x/alpha",
  defaultBranch: "main",
  packageName: "@example/alpha",
  cloudAppId: "cloud-app-alpha",
  lastOpenedAt: "2026-07-05T00:00:00.000Z",
};
const PROJECT_B: ProjectSummaryDTO = {
  id: "proj-b",
  name: "Beta",
  localPath: "/home/dev/beta",
  packageName: null,
  lastOpenedAt: "2026-07-04T00:00:00.000Z",
};

describe("handleProjectRoutes", () => {
  it("returns false for unrelated paths (no capture)", async () => {
    const helpers = makeHelpers();
    const handled = await handleProjectRoutes(
      ctx("GET", "/api/other", helpers),
      { readRegistry: () => ({ projects: [], activeProjectId: null }) },
    );
    expect(handled).toBe(false);
    expect(helpers.json).not.toHaveBeenCalled();
    expect(helpers.error).not.toHaveBeenCalled();
  });

  it("GET /api/projects returns the registry list + active pointer", async () => {
    const helpers = makeHelpers();
    const registry: ProjectListDTO = {
      projects: [PROJECT_A, PROJECT_B],
      activeProjectId: "proj-a",
    };
    const handled = await handleProjectRoutes(
      ctx("GET", "/api/projects", helpers),
      { readRegistry: () => registry },
    );
    expect(handled).toBe(true);
    expect(helpers.json).toHaveBeenCalledWith(res, registry);
    expect(helpers.error).not.toHaveBeenCalled();
  });

  it("GET /api/projects renders empty when the registry is absent", async () => {
    const helpers = makeHelpers();
    const handled = await handleProjectRoutes(
      ctx("GET", "/api/projects", helpers),
      { readRegistry: () => ({ projects: [], activeProjectId: null }) },
    );
    expect(handled).toBe(true);
    expect(helpers.json).toHaveBeenCalledWith(res, {
      projects: [],
      activeProjectId: null,
    });
  });

  it("POST /api/projects/register validates and forwards an owned workspace", async () => {
    const helpers = makeHelpers();
    helpers.readJsonBody.mockResolvedValue({
      name: "  Alpha  ",
      localPath: "/home/dev/alpha",
      repoUrl: "  https://github.com/x/alpha  ",
      defaultBranch: " main ",
    });
    const register = vi.fn(() => PROJECT_A);

    const handled = await handleProjectRoutes(
      ctx("POST", "/api/projects/register", helpers),
      { register },
    );

    expect(handled).toBe(true);
    expect(register).toHaveBeenCalledWith({
      name: "Alpha",
      localPath: "/home/dev/alpha",
      repoUrl: "https://github.com/x/alpha",
      defaultBranch: "main",
    });
    expect(helpers.json).toHaveBeenCalledWith(res, PROJECT_A);
    expect(helpers.error).not.toHaveBeenCalled();
  });

  it("POST /api/projects/register rejects relative paths and binding fields", async () => {
    const register = vi.fn();

    const relative = makeHelpers();
    relative.readJsonBody.mockResolvedValue({
      name: "Alpha",
      localPath: "relative/alpha",
    });
    await handleProjectRoutes(ctx("POST", "/api/projects/register", relative), {
      register,
    });
    expect(relative.error).toHaveBeenCalledWith(
      res,
      "localPath must be an absolute path",
      400,
    );

    const cloudBinding = makeHelpers();
    cloudBinding.readJsonBody.mockResolvedValue({
      name: "Alpha",
      localPath: "/home/dev/alpha",
      cloudAppId: "must-use-publish-binding",
    });
    await handleProjectRoutes(
      ctx("POST", "/api/projects/register", cloudBinding),
      { register },
    );
    expect(cloudBinding.error).toHaveBeenCalledWith(
      res,
      "Unknown field: cloudAppId",
      400,
    );
    expect(register).not.toHaveBeenCalled();
  });

  it("POST /api/projects/register writes the real atomic registry and returns its canonical record", async () => {
    const stateDir = mkdtempSync(join(os.tmpdir(), "project-routes-register-"));
    const projectDir = join(stateDir, "owned-project");
    mkdirSync(projectDir);
    const canonicalProjectDir = realpathSync(projectDir);
    writeFileSync(
      join(projectDir, "package.json"),
      `${JSON.stringify({ name: "@example/owned-project" }, null, 2)}\n`,
      "utf8",
    );
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = stateDir;
    try {
      expect(readProjectRegistryOrThrow()).toBeNull();
      const helpers = makeHelpers();
      helpers.readJsonBody.mockResolvedValue({
        name: "Owned Project",
        localPath: canonicalProjectDir,
      });

      const handled = await handleProjectRoutes(
        ctx("POST", "/api/projects/register", helpers),
      );
      expect(handled).toBe(true);
      expect(helpers.error).not.toHaveBeenCalled();
      expect(helpers.json.mock.calls[0]?.[1]).toMatchObject({
        name: "Owned Project",
        localPath: canonicalProjectDir,
        packageName: "@example/owned-project",
      });

      const persisted = JSON.parse(
        readFileSync(join(stateDir, "projects.json"), "utf8"),
      ) as {
        activeProjectId: string | null;
        projects: Array<{ id: string; name: string; localPath: string }>;
      };
      expect(persisted.activeProjectId).toBeNull();
      expect(persisted.projects).toHaveLength(1);
      expect(persisted.projects[0]).toMatchObject({
        id: expect.any(String),
        name: "Owned Project",
        localPath: canonicalProjectDir,
      });
      expect(persisted.projects[0]).not.toHaveProperty("packageName");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.ELIZA_STATE_DIR;
      } else {
        process.env.ELIZA_STATE_DIR = previousStateDir;
      }
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("POST /api/projects/:id/activate switches the active project", async () => {
    const helpers = makeHelpers();
    const activate = vi.fn((id: string) =>
      id === "proj-b" ? PROJECT_B : null,
    );
    const handled = await handleProjectRoutes(
      ctx("POST", "/api/projects/proj-b/activate", helpers),
      { activate },
    );
    expect(handled).toBe(true);
    expect(activate).toHaveBeenCalledWith("proj-b");
    expect(helpers.json).toHaveBeenCalledWith(res, PROJECT_B);
    expect(helpers.error).not.toHaveBeenCalled();
  });

  it("binds and unbinds a project's Cloud record through the dedicated path", async () => {
    const bindHelpers = makeHelpers();
    bindHelpers.readJsonBody.mockResolvedValue({
      cloudAppId: " cloud-app-beta ",
    });
    const bindCloudApp = vi.fn((projectId: string, cloudAppId: string) => ({
      ...PROJECT_B,
      id: projectId,
      cloudAppId,
    }));

    await handleProjectRoutes(
      ctx("POST", "/api/projects/proj-b/cloud-app", bindHelpers),
      { bindCloudApp },
    );

    expect(bindCloudApp).toHaveBeenCalledWith("proj-b", "cloud-app-beta");
    expect(bindHelpers.json).toHaveBeenCalledWith(
      res,
      expect.objectContaining({
        id: "proj-b",
        cloudAppId: "cloud-app-beta",
      }),
    );

    const unbindHelpers = makeHelpers();
    const unbindCloudApp = vi.fn(() => PROJECT_B);
    await handleProjectRoutes(
      ctx("DELETE", "/api/projects/proj-b/cloud-app", unbindHelpers),
      { unbindCloudApp },
    );

    expect(unbindCloudApp).toHaveBeenCalledWith("proj-b");
    expect(unbindHelpers.json).toHaveBeenCalledWith(res, PROJECT_B);
  });

  it("rejects invalid Cloud binding input without touching the registry", async () => {
    const helpers = makeHelpers();
    helpers.readJsonBody.mockResolvedValue({ cloudAppId: " ", extra: true });
    const bindCloudApp = vi.fn();

    await handleProjectRoutes(
      ctx("POST", "/api/projects/proj-b/cloud-app", helpers),
      { bindCloudApp },
    );

    expect(bindCloudApp).not.toHaveBeenCalled();
    expect(helpers.error).toHaveBeenCalledWith(
      res,
      "cloudAppId is required",
      400,
    );
  });

  it("POST activate with an unknown id returns 404", async () => {
    const helpers = makeHelpers();
    const handled = await handleProjectRoutes(
      ctx("POST", "/api/projects/nope/activate", helpers),
      { activate: () => null },
    );
    expect(handled).toBe(true);
    expect(helpers.error).toHaveBeenCalledWith(res, "Project not found", 404);
    expect(helpers.json).not.toHaveBeenCalled();
  });

  it("POST activate with a slashy/invalid id returns 400", async () => {
    const helpers = makeHelpers();
    const activate = vi.fn();
    // A path segment with an encoded slash decodes to an id containing "/",
    // which must be rejected before hitting the registry.
    const handled = await handleProjectRoutes(
      ctx("POST", "/api/projects/a%2Fb/activate", helpers),
      { activate },
    );
    expect(handled).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    expect(helpers.error).toHaveBeenCalledWith(res, "Invalid project id", 400);
  });

  it("POST activate with malformed percent-encoding returns 400", async () => {
    const helpers = makeHelpers();
    const activate = vi.fn();
    const handled = await handleProjectRoutes(
      ctx("POST", "/api/projects/%E0%A4%A/activate", helpers),
      { activate },
    );
    expect(handled).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    expect(helpers.error).toHaveBeenCalledWith(res, "Invalid project id", 400);
  });

  it("surfaces a 500 when the registry read throws", async () => {
    const helpers = makeHelpers();
    const handled = await handleProjectRoutes(
      ctx("GET", "/api/projects", helpers),
      {
        readRegistry: () => {
          throw new Error("disk gone");
        },
      },
    );
    expect(handled).toBe(true);
    expect(helpers.error).toHaveBeenCalledWith(
      res,
      "Failed to read project registry",
      500,
    );
  });

  it("uses a stable legacy workspace-folder project id across list and activation", async () => {
    const stateDir = mkdtempSync(join(os.tmpdir(), "project-routes-legacy-"));
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = stateDir;
    try {
      writeFileSync(
        join(stateDir, "workspace-folder.json"),
        `${JSON.stringify(
          {
            path: "/tmp/legacy-folder",
            bookmark: null,
            updatedAt: "2026-07-05T00:00:00.000Z",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const first = makeHelpers();
      await handleProjectRoutes(ctx("GET", "/api/projects", first));
      const firstBody = first.json.mock.calls[0]?.[1] as ProjectListDTO;
      const projectId = firstBody.projects[0]?.id;
      expect(projectId).toMatch(/^legacy-[a-f0-9]{16}$/);
      expect(firstBody.activeProjectId).toBe(projectId);

      const second = makeHelpers();
      await handleProjectRoutes(ctx("GET", "/api/projects", second));
      const secondBody = second.json.mock.calls[0]?.[1] as ProjectListDTO;
      expect(secondBody.projects[0]?.id).toBe(projectId);
      expect(secondBody.activeProjectId).toBe(projectId);

      const activate = makeHelpers();
      await handleProjectRoutes(
        ctx("POST", `/api/projects/${projectId}/activate`, activate),
      );
      expect(activate.error).not.toHaveBeenCalled();
      expect(activate.json.mock.calls[0]?.[1]).toMatchObject({
        id: projectId,
        localPath: "/tmp/legacy-folder",
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.ELIZA_STATE_DIR;
      } else {
        process.env.ELIZA_STATE_DIR = previousStateDir;
      }
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
