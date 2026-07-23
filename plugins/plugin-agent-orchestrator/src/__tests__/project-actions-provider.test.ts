/**
 * Exercises the Project planner surface against the real on-disk registry.
 * Action callbacks, active selection persistence, publication context, ambiguity,
 * and the provider's explicit degraded state are covered without registry mocks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import {
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  readProjectRegistry,
  type State,
  upsertProject,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractProjectReference,
  getProjectAction,
  listProjectsAction,
  matchProjectReference,
  setActiveProjectAction,
} from "../actions/projects.ts";
import { activeProjectProvider } from "../providers/active-project.ts";

const ROOM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTITY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MESSAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function message(text: string): Memory {
  return {
    id: MESSAGE_ID,
    entityId: ENTITY_ID,
    roomId: ROOM_ID,
    content: { text, source: "test" },
  } as unknown as Memory;
}

function callback(): {
  callback: HandlerCallback;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async () => []);
  return { callback: spy as unknown as HandlerCallback, spy };
}

function runtime(reportError = vi.fn(async () => undefined)): IAgentRuntime {
  return { reportError } as unknown as IAgentRuntime;
}

describe("Project actions and active-project provider", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(os.tmpdir(), "project-actions-provider-"));
    originalStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = originalStateDir;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("extracts nested structured references before top-level or message text", () => {
    expect(
      extractProjectReference(message("message fallback"), {
        project: "top-level",
        parameters: { projectId: " nested-id " },
      }),
    ).toBe("nested-id");
    expect(extractProjectReference(message(" raw fallback "))).toBe(
      "raw fallback",
    );
  });

  it("resolves exact identity fields and refuses ambiguous exact names", () => {
    const projects = [
      upsertProject({
        id: "project-alpha",
        name: "Shared",
        localPath: "/tmp/project-alpha",
        repoUrl: "https://github.com/example/alpha",
      }),
      upsertProject({
        id: "project-beta",
        name: "Shared",
        localPath: "/tmp/project-beta",
        repoUrl: "https://github.com/example/beta",
      }),
    ];

    expect(
      matchProjectReference(projects, "https://github.com/example/beta").project
        ?.id,
    ).toBe("project-beta");
    expect(
      matchProjectReference(projects, resolve("/tmp/project-alpha")).project
        ?.id,
    ).toBe("project-alpha");
    expect(matchProjectReference(projects, "Shared")).toEqual({
      project: null,
      candidates: projects,
    });
  });

  it("lists an honest empty state when the registry has not been created", async () => {
    const response = callback();
    const result = await listProjectsAction.handler(
      runtime(),
      message("list projects"),
      {} as State,
      undefined,
      response.callback,
    );

    expect(result).toMatchObject({
      success: true,
      userFacingText: "There are no registered projects yet.",
      data: { activeProjectId: null, projects: [] },
    });
    expect(response.spy).toHaveBeenCalledWith({
      text: "There are no registered projects yet.",
      actions: ["LIST_PROJECTS"],
    });
  });

  it("lists active and Cloud-bound projects with structured planner data", async () => {
    const active = upsertProject({
      id: "project-active",
      name: "Active project",
      localPath: "/tmp/project-active",
      repoUrl: "https://github.com/example/active",
      defaultBranch: "develop",
      cloudAppId: "app_active",
    });
    upsertProject({
      id: "project-local",
      name: "Local project",
      localPath: "/tmp/project-local",
    });
    await setActiveProjectAction.handler(
      runtime(),
      message("switch"),
      {} as State,
      { parameters: { project: active.id } },
    );

    const response = callback();
    const result = await listProjectsAction.handler(
      runtime(),
      message("list projects"),
      {} as State,
      undefined,
      response.callback,
    );

    expect(result.success).toBe(true);
    expect(result.userFacingText).toContain(
      "Active project [active, cloud-bound]",
    );
    expect(result.userFacingText).toContain("Local project");
    expect(result.data).toMatchObject({
      activeProjectId: active.id,
      projects: [
        {
          id: active.id,
          isActive: true,
          cloudAppId: "app_active",
        },
        {
          id: "project-local",
          isActive: false,
        },
      ],
    });
    expect(response.spy).toHaveBeenCalledOnce();
  });

  it("gets an explicitly named project with repository and publication details", async () => {
    const project = upsertProject({
      id: "project-published",
      name: "Published site",
      localPath: "/tmp/project-published",
      repoUrl: "https://github.com/example/published",
      defaultBranch: "main",
      cloudAppId: "app_published",
    });
    const response = callback();

    const result = await getProjectAction.handler(
      runtime(),
      message("show the selected project"),
      {} as State,
      { parameters: { projectId: project.id } },
      response.callback,
    );

    expect(result).toMatchObject({
      success: true,
      verifiedUserFacing: true,
      data: {
        project: {
          id: project.id,
          repoUrl: "https://github.com/example/published",
          defaultBranch: "main",
          cloudAppId: "app_published",
          isActive: false,
        },
      },
    });
    expect(result.userFacingText).toContain(
      "Cloud binding: Cloud app app_published",
    );
    expect(response.spy).toHaveBeenCalledWith({
      text: result.userFacingText,
      actions: ["GET_PROJECT"],
    });
  });

  it("defaults a singular get to the persisted active project", async () => {
    const inactive = upsertProject({
      id: "project-inactive",
      name: "Inactive",
      localPath: "/tmp/project-inactive",
    });
    const active = upsertProject({
      id: "project-default",
      name: "Default",
      localPath: "/tmp/project-default",
    });
    await setActiveProjectAction.handler(
      runtime(),
      message("switch"),
      {} as State,
      { parameters: { project: active.id } },
    );

    const result = await getProjectAction.handler(
      runtime(),
      message("what is my current project?"),
      {} as State,
    );

    expect(result).toMatchObject({
      success: true,
      data: { project: { id: active.id, isActive: true } },
    });
    expect(result.data).not.toMatchObject({
      project: { id: inactive.id },
    });
  });

  it("returns candidate ids instead of guessing an ambiguous project", async () => {
    const first = upsertProject({
      id: "project-shared-a",
      name: "Shared",
      localPath: "/tmp/project-shared-a",
    });
    const second = upsertProject({
      id: "project-shared-b",
      name: "Shared",
      localPath: "/tmp/project-shared-b",
    });
    const response = callback();

    const result = await getProjectAction.handler(
      runtime(),
      message("show project"),
      {} as State,
      { parameters: { project: "Shared" } },
      response.callback,
    );

    expect(result).toMatchObject({
      success: false,
      text: "Ambiguous project reference.",
      data: {
        reason: "ambiguous",
        candidates: [first.id, second.id],
      },
    });
    expect(result.userFacingText).toContain(`Shared (${first.id})`);
    expect(result.userFacingText).toContain(`Shared (${second.id})`);
    expect(response.spy).toHaveBeenCalledWith({
      text: result.userFacingText,
      actions: ["GET_PROJECT"],
    });
  });

  it("sets the active project and persists the selection for a fresh read", async () => {
    upsertProject({
      id: "project-first",
      name: "First",
      localPath: "/tmp/project-first",
    });
    const selected = upsertProject({
      id: "project-selected",
      name: "Selected",
      localPath: "/tmp/project-selected",
    });
    const response = callback();

    const result = await setActiveProjectAction.handler(
      runtime(),
      message("use selected"),
      {} as State,
      { parameters: { project: selected.name } },
      response.callback,
    );

    expect(result).toMatchObject({
      success: true,
      verifiedUserFacing: true,
      data: { project: { id: selected.id, isActive: true } },
    });
    const persisted = readProjectRegistry({
      ELIZA_STATE_DIR: stateDir,
    });
    expect(persisted?.activeProjectId).toBe(selected.id);
    expect(
      persisted?.projects.find((project) => project.id === selected.id)
        ?.lastOpenedAt,
    ).toBeTruthy();
    expect(response.spy).toHaveBeenCalledWith({
      text: `Active project is now "Selected" at ${resolve("/tmp/project-selected")}.`,
      actions: ["SET_ACTIVE_PROJECT"],
    });
  });

  it("provides the active project with its Cloud binding", async () => {
    const active = upsertProject({
      id: "project-bound",
      name: "Bound",
      localPath: "/tmp/project-bound",
      repoUrl: "https://github.com/example/bound",
      defaultBranch: "develop",
      cloudAppId: "app_bound",
    });
    await setActiveProjectAction.handler(
      runtime(),
      message("switch"),
      {} as State,
      { parameters: { project: active.id } },
    );

    const result = await activeProjectProvider.get(
      runtime(),
      message("context"),
      {} as State,
    );

    expect(result.text).toContain("Name: Bound");
    expect(result.text).toContain("Cloud binding: present");
    expect(result.text).toContain("Cloud app id: app_bound");
    expect(result.values).toMatchObject({
      activeProjectId: active.id,
      activeProjectCloudAppId: "app_bound",
    });
    expect(result.data).toMatchObject({
      activeProject: {
        id: active.id,
        repoUrl: "https://github.com/example/bound",
        cloudAppId: "app_bound",
      },
      projectCount: 1,
    });
  });

  it("provides an explicit unbound state without inventing a Cloud app id", async () => {
    const active = upsertProject({
      id: "project-unbound",
      name: "Unbound",
      localPath: "/tmp/project-unbound",
    });
    await setActiveProjectAction.handler(
      runtime(),
      message("switch"),
      {} as State,
      { parameters: { project: active.id } },
    );

    const result = await activeProjectProvider.get(
      runtime(),
      message("context"),
      {} as State,
    );

    expect(result.text).toContain("Cloud binding: none");
    expect(result.text).not.toContain("Cloud app id:");
    expect(result.values).toMatchObject({
      activeProjectId: active.id,
      activeProjectCloudAppId: "",
    });
    expect(result.data).toMatchObject({
      activeProject: { id: active.id },
      projectCount: 1,
    });
  });

  it("reports a registry read failure and returns distinguishable degraded context", async () => {
    const reportError = vi.fn(async () => undefined);
    const originalEnv = process.env;
    process.env = new Proxy(originalEnv, {
      get(target, property, receiver) {
        if (property === "ELIZA_STATE_DIR") {
          throw new Error("state directory unavailable");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    try {
      const result = await activeProjectProvider.get(
        runtime(reportError),
        message("context"),
        {} as State,
      );

      expect(result.text).toContain("Project registry unavailable");
      expect(result.data).toEqual({
        activeProject: null,
        projectCount: null,
        degraded: true,
      });
      expect(reportError).toHaveBeenCalledWith(
        "AgentOrchestrator.ACTIVE_PROJECT",
        expect.objectContaining({ message: "state directory unavailable" }),
      );
    } finally {
      process.env = originalEnv;
    }
  });
});
