import { describe, expect, it } from "vitest";

describe("Shell Plugin Integration Tests", () => {
  describe("Plugin Structure", () => {
    it("should export shellPlugin", async () => {
      const { shellPlugin } = await import("../index");
      expect(shellPlugin).toBeDefined();
      expect(shellPlugin.name).toBe("shell");
    }, 30000);

    it("should have correct description", async () => {
      const { shellPlugin } = await import("../index");
      expect(shellPlugin.description).toContain("shell");
    });

    it("should have services defined", async () => {
      const { shellPlugin } = await import("../index");
      expect(shellPlugin.services).toBeDefined();
      expect(Array.isArray(shellPlugin.services)).toBe(true);
    });

    it("should have providers defined", async () => {
      const { shellPlugin } = await import("../index");
      expect(shellPlugin.providers).toBeDefined();
      expect(Array.isArray(shellPlugin.providers)).toBe(true);
    });

    it("should have actions defined", async () => {
      const { shellPlugin } = await import("../index");
      expect(shellPlugin.actions).toBeDefined();
      expect(Array.isArray(shellPlugin.actions)).toBe(true);
      expect(shellPlugin.actions?.length).toBe(2);
    });
  });

  describe("Actions", () => {
    it("should export executeCommand", async () => {
      const { executeCommand } = await import("../actions");
      expect(executeCommand).toBeDefined();
      expect(executeCommand.name).toBe("EXECUTE_COMMAND");
    });

    it("should export clearHistory", async () => {
      const { clearHistory } = await import("../actions");
      expect(clearHistory).toBeDefined();
      expect(clearHistory.name).toBe("CLEAR_SHELL_HISTORY");
    });

    it("executeCommand should have similes", async () => {
      const { executeCommand } = await import("../actions");
      expect(executeCommand.similes).toBeDefined();
      expect(executeCommand.similes?.includes("RUN_COMMAND")).toBe(true);
    });
  });

  describe("Providers", () => {
    it("should export shellHistoryProvider", async () => {
      const { shellHistoryProvider } = await import("../providers");
      expect(shellHistoryProvider).toBeDefined();
      expect(shellHistoryProvider.name).toBe("SHELL_HISTORY");
    });
  });

  describe("Service", () => {
    it("should export ShellService", async () => {
      const { ShellService } = await import("../services/shellService");
      expect(ShellService).toBeDefined();
    });
  });

  describe("Utils", () => {
    it("should export validatePath", async () => {
      const { validatePath } = await import("../utils");
      expect(typeof validatePath).toBe("function");
    });

    it("should export isSafeCommand", async () => {
      const { isSafeCommand } = await import("../utils");
      expect(typeof isSafeCommand).toBe("function");
    });

    it("should export isForbiddenCommand", async () => {
      const { isForbiddenCommand } = await import("../utils");
      expect(typeof isForbiddenCommand).toBe("function");
    });

    it("should export extractBaseCommand", async () => {
      const { extractBaseCommand } = await import("../utils");
      expect(typeof extractBaseCommand).toBe("function");
    });

    it("should validate safe commands", async () => {
      const { isSafeCommand } = await import("../utils");
      expect(isSafeCommand("ls -la")).toBe(true);
      expect(isSafeCommand("echo hello")).toBe(true);
      expect(isSafeCommand("pwd")).toBe(true);
    });

    it("should reject unsafe commands", async () => {
      const { isSafeCommand } = await import("../utils");
      expect(isSafeCommand("cd ../..")).toBe(false);
      expect(isSafeCommand("echo $(whoami)")).toBe(false);
      expect(isSafeCommand("cmd1 && cmd2")).toBe(false);
    });

    it("should extract base command", async () => {
      const { extractBaseCommand } = await import("../utils");
      expect(extractBaseCommand("ls -la")).toBe("ls");
      expect(extractBaseCommand("echo hello world")).toBe("echo");
      expect(extractBaseCommand("git status")).toBe("git");
    });
  });

  describe("Types", () => {
    it("should export CommandResult type", async () => {
      const types = await import("../types");
      expect(types).toBeDefined();
    });
  });
});
