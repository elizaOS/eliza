/**
 * Unit tests for the project registry HTTP routes (#13776 item 5). The handler
 * takes injectable `readRegistry`/`activate` deps so these tests drive the
 * request/response contract without touching a real state dir: list shape,
 * activate success (200 + record), unknown id (404), invalid id (400), and
 * pass-through (returns false) for unrelated paths.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import { join } from "node:path";
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
  lastOpenedAt: "2026-07-05T00:00:00.000Z",
};
const PROJECT_B: ProjectSummaryDTO = {
  id: "proj-b",
  name: "Beta",
  localPath: "/home/dev/beta",
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
