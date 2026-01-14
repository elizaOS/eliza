import { describe, expect, it } from "vitest";

describe("Eliza Coder Plugin Integration", () => {
  it("exports coderPlugin", async () => {
    const { coderPlugin } = await import("../index");
    expect(coderPlugin).toBeDefined();
    expect(coderPlugin.name).toBe("eliza-coder");
    expect(Array.isArray(coderPlugin.actions)).toBe(true);
    expect(Array.isArray(coderPlugin.providers)).toBe(true);
    expect(Array.isArray(coderPlugin.services)).toBe(true);
  });

  it("exports actions", async () => {
    const actions = await import("../actions");
    expect(actions.readFile.name).toBe("READ_FILE");
    expect(actions.writeFile.name).toBe("WRITE_FILE");
    expect(actions.editFile.name).toBe("EDIT_FILE");
    expect(actions.listFiles.name).toBe("LIST_FILES");
    expect(actions.searchFiles.name).toBe("SEARCH_FILES");
    expect(actions.changeDirectory.name).toBe("CHANGE_DIRECTORY");
    expect(actions.executeShell.name).toBe("EXECUTE_SHELL");
    expect(actions.git.name).toBe("GIT");
  });

  it("exports provider", async () => {
    const { coderStatusProvider } = await import("../providers");
    expect(coderStatusProvider.name).toBe("CODER_STATUS");
  });

  it("exports service + utils", async () => {
    const { CoderService } = await import("../services/coderService");
    expect(CoderService).toBeDefined();
    const utils = await import("../utils");
    expect(typeof utils.validatePath).toBe("function");
    expect(typeof utils.isSafeCommand).toBe("function");
  });
});
