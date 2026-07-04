/**
 * Create command tests drive template rendering through the command surface
 * while stubbing only interactive prompt responses.
 */

import * as clack from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTemplateTree } from "../scaffold.js";
import { create } from "./create.js";

vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(),
  confirm: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  select: vi.fn(),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  })),
  text: vi.fn(),
}));

vi.mock("../manifest.js", () => ({
  getTemplateById: vi.fn((id: string) =>
    id === "project"
      ? {
          description: "Project",
          id: "project",
          languages: ["typescript"],
          name: "Project",
          version: 1,
        }
      : undefined,
  ),
  getTemplates: vi.fn(() => []),
  getTemplatesDir: vi.fn(() => "/tmp/templates"),
  TEMPLATE_ICONS: {},
}));

vi.mock("../package-info.js", () => ({
  getCliVersion: vi.fn(() => "test-version"),
}));

vi.mock("../project-metadata.js", () => ({
  writeProjectMetadata: vi.fn(),
}));

vi.mock("../scaffold.js", () => ({
  buildFullstackTemplateValues: vi.fn((projectName: string) => ({
    appName: projectName,
  })),
  buildMetadata: vi.fn(() => ({})),
  buildPluginTemplateValues: vi.fn(),
  getTemplateReplacementEntries: vi.fn(() => []),
  hydrateGitSubmoduleWorkspace: vi.fn(),
  initializeGitSubmodule: vi.fn(),
  renderTemplateTree: vi.fn(() => ({})),
  resolveTemplateSourceDir: vi.fn(() => "/tmp/templates/project"),
  resolveTemplateUpstream: vi.fn(),
}));

describe("create command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects explicit names that normalize to empty before rendering", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    await expect(
      create("!!!", {
        skipUpstream: true,
        template: "project",
        yes: true,
      }),
    ).rejects.toThrow("exit:1");

    expect(clack.cancel).toHaveBeenCalledWith("Project name is required.");
    expect(renderTemplateTree).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
