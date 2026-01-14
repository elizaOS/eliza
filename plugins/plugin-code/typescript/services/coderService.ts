import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type {
  CoderConfig,
  CommandHistoryEntry,
  CommandResult,
  FileOperation,
} from "../types";
import {
  isForbiddenCommand,
  isSafeCommand,
  loadCoderConfig,
  validatePath,
} from "../utils";

export class CoderService extends Service {
  public static serviceType = "coder";
  private coderConfig: CoderConfig;
  private currentDirectoryByConversation = new Map<string, string>();
  private commandHistoryByConversation = new Map<
    string,
    CommandHistoryEntry[]
  >();
  private maxHistoryPerConversation = 100;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    this.coderConfig = loadCoderConfig();
  }

  static async start(runtime: IAgentRuntime): Promise<CoderService> {
    const instance = new CoderService(runtime);
    logger.info("Coder service initialized");
    return instance;
  }

  async stop(): Promise<void> {
    logger.info("Coder service stopped");
  }

  get capabilityDescription(): string {
    return "Filesystem + shell + git tools within a restricted directory";
  }

  getAllowedDirectory(): string {
    return this.coderConfig.allowedDirectory;
  }

  getCurrentDirectory(conversationId: string): string {
    return (
      this.currentDirectoryByConversation.get(conversationId) ??
      this.coderConfig.allowedDirectory
    );
  }

  setCurrentDirectory(conversationId: string, dir: string): void {
    this.currentDirectoryByConversation.set(conversationId, dir);
  }

  getCommandHistory(
    conversationId: string,
    limit: number,
  ): CommandHistoryEntry[] {
    const all = this.commandHistoryByConversation.get(conversationId) ?? [];
    if (limit <= 0) return [];
    return all.slice(-limit);
  }

  private addToHistory(
    conversationId: string | undefined,
    command: string,
    result: CommandResult,
    fileOperations?: FileOperation[],
  ): void {
    if (!conversationId) return;
    const list = this.commandHistoryByConversation.get(conversationId) ?? [];
    list.push({
      timestamp: Date.now(),
      workingDirectory: result.executedIn,
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      fileOperations,
    });
    const trimmed =
      list.length > this.maxHistoryPerConversation
        ? list.slice(-this.maxHistoryPerConversation)
        : list;
    this.commandHistoryByConversation.set(conversationId, trimmed);
  }

  private ensureEnabled(): string | null {
    if (this.coderConfig.enabled) return null;
    return "Coder plugin is disabled. Set CODER_ENABLED=true to enable.";
  }

  private resolveWithin(
    conversationId: string,
    targetPath: string,
  ): { fullPath: string; relPath: string } | { error: string } {
    const cwd = this.getCurrentDirectory(conversationId);
    const validated = validatePath(
      targetPath,
      this.coderConfig.allowedDirectory,
      cwd,
    );
    if (!validated)
      return { error: "Cannot access path outside allowed directory" };
    const rel = path.relative(this.coderConfig.allowedDirectory, validated);
    return { fullPath: validated, relPath: rel.length === 0 ? "." : rel };
  }

  async changeDirectory(
    conversationId: string,
    targetPath: string,
  ): Promise<CommandResult> {
    const disabled = this.ensureEnabled();
    if (disabled) {
      return {
        success: false,
        stdout: "",
        stderr: disabled,
        exitCode: 1,
        error: "Coder disabled",
        executedIn: this.getCurrentDirectory(conversationId),
      };
    }

    const resolved = this.resolveWithin(conversationId, targetPath);
    if ("error" in resolved) {
      return {
        success: false,
        stdout: "",
        stderr: resolved.error,
        exitCode: 1,
        error: "Permission denied",
        executedIn: this.getCurrentDirectory(conversationId),
      };
    }

    try {
      const stat = await fs.stat(resolved.fullPath);
      if (!stat.isDirectory()) {
        return {
          success: false,
          stdout: "",
          stderr: "Not a directory",
          exitCode: 1,
          error: "Not a directory",
          executedIn: this.getCurrentDirectory(conversationId),
        };
      }
      this.setCurrentDirectory(conversationId, resolved.fullPath);
      return {
        success: true,
        stdout: `Changed directory to: ${resolved.fullPath}`,
        stderr: "",
        exitCode: 0,
        executedIn: resolved.fullPath,
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        success: false,
        stdout: "",
        stderr: e.message,
        exitCode: 1,
        error: "Failed to change directory",
        executedIn: this.getCurrentDirectory(conversationId),
      };
    }
  }

  async readFile(
    conversationId: string,
    filepath: string,
  ): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    const disabled = this.ensureEnabled();
    if (disabled) return { ok: false, error: disabled };
    const resolved = this.resolveWithin(conversationId, filepath);
    if ("error" in resolved) return { ok: false, error: resolved.error };
    try {
      const stat = await fs.stat(resolved.fullPath);
      if (stat.isDirectory())
        return { ok: false, error: "Path is a directory" };
      const content = await fs.readFile(resolved.fullPath, "utf-8");
      return { ok: true, content };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        ok: false,
        error: e.code === "ENOENT" ? "File not found" : e.message,
      };
    }
  }

  async writeFile(
    conversationId: string,
    filepath: string,
    content: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const disabled = this.ensureEnabled();
    if (disabled) return { ok: false, error: disabled };
    const resolved = this.resolveWithin(conversationId, filepath);
    if ("error" in resolved) return { ok: false, error: resolved.error };
    try {
      await fs.mkdir(path.dirname(resolved.fullPath), { recursive: true });
      await fs.writeFile(resolved.fullPath, content, "utf-8");
      return { ok: true };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return { ok: false, error: e.message };
    }
  }

  async editFile(
    conversationId: string,
    filepath: string,
    oldStr: string,
    newStr: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const disabled = this.ensureEnabled();
    if (disabled) return { ok: false, error: disabled };
    const resolved = this.resolveWithin(conversationId, filepath);
    if ("error" in resolved) return { ok: false, error: resolved.error };
    try {
      const content = await fs.readFile(resolved.fullPath, "utf-8");
      if (!content.includes(oldStr))
        return { ok: false, error: "Could not find old_str in file" };
      const next = content.replace(oldStr, newStr);
      await fs.writeFile(resolved.fullPath, next, "utf-8");
      return { ok: true };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        ok: false,
        error: e.code === "ENOENT" ? "File not found" : e.message,
      };
    }
  }

  async listFiles(
    conversationId: string,
    dirPath: string,
  ): Promise<{ ok: true; items: string[] } | { ok: false; error: string }> {
    const disabled = this.ensureEnabled();
    if (disabled) return { ok: false, error: disabled };
    const resolved = this.resolveWithin(conversationId, dirPath);
    if ("error" in resolved) return { ok: false, error: resolved.error };
    try {
      const entries = await fs.readdir(resolved.fullPath, {
        withFileTypes: true,
      });
      const items = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`)
        .sort((a, b) => a.localeCompare(b));
      return { ok: true, items };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        ok: false,
        error: e.code === "ENOENT" ? "Directory not found" : e.message,
      };
    }
  }

  async searchFiles(
    conversationId: string,
    pattern: string,
    dirPath: string,
    maxMatches: number,
  ): Promise<
    | {
        ok: true;
        matches: Array<{ file: string; line: number; content: string }>;
      }
    | { ok: false; error: string }
  > {
    const disabled = this.ensureEnabled();
    if (disabled) return { ok: false, error: disabled };
    const resolved = this.resolveWithin(conversationId, dirPath);
    if ("error" in resolved) return { ok: false, error: resolved.error };
    const needle = pattern.trim();
    if (!needle) return { ok: false, error: "Missing pattern" };
    const limit =
      Number.isFinite(maxMatches) && maxMatches > 0
        ? Math.min(500, Math.floor(maxMatches))
        : 50;
    const matches: Array<{ file: string; line: number; content: string }> = [];
    await this.searchInDirectory(
      resolved.fullPath,
      needle.toLowerCase(),
      matches,
      limit,
    );
    return { ok: true, matches };
  }

  private async searchInDirectory(
    dir: string,
    needleLower: string,
    matches: Array<{ file: string; line: number; content: string }>,
    maxMatches: number,
  ): Promise<void> {
    if (matches.length >= maxMatches) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= maxMatches) break;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === "build" ||
          entry.name === "coverage" ||
          entry.name === ".git"
        ) {
          continue;
        }
        await this.searchInDirectory(full, needleLower, matches, maxMatches);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = await fs.readFile(full, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxMatches) break;
        const line = lines[i] ?? "";
        if (!line.toLowerCase().includes(needleLower)) continue;
        matches.push({
          file: path.relative(this.coderConfig.allowedDirectory, full),
          line: i + 1,
          content: line.trim().slice(0, 240),
        });
      }
    }
  }

  async executeShell(
    command: string,
    conversationId: string,
  ): Promise<CommandResult> {
    const disabled = this.ensureEnabled();
    if (disabled) {
      return {
        success: false,
        stdout: "",
        stderr: disabled,
        exitCode: 1,
        error: "Coder disabled",
        executedIn: this.getCurrentDirectory(conversationId),
      };
    }

    const trimmed = command.trim();
    if (!trimmed) {
      return {
        success: false,
        stdout: "",
        stderr: "Invalid command",
        exitCode: 1,
        error: "Empty command",
        executedIn: this.getCurrentDirectory(conversationId),
      };
    }

    if (!isSafeCommand(trimmed)) {
      return {
        success: false,
        stdout: "",
        stderr: "Command contains forbidden patterns",
        exitCode: 1,
        error: "Security policy violation",
        executedIn: this.getCurrentDirectory(conversationId),
      };
    }

    if (isForbiddenCommand(trimmed, this.coderConfig.forbiddenCommands)) {
      return {
        success: false,
        stdout: "",
        stderr: "Command is forbidden by security policy",
        exitCode: 1,
        error: "Forbidden command",
        executedIn: this.getCurrentDirectory(conversationId),
      };
    }

    const cwd = this.getCurrentDirectory(conversationId);

    try {
      const stdout = execSync(trimmed, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
        timeout: this.coderConfig.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      }).toString();
      const result: CommandResult = {
        success: true,
        stdout,
        stderr: "",
        exitCode: 0,
        executedIn: cwd,
      };
      this.addToHistory(conversationId, trimmed, result);
      return result;
    } catch (err) {
      const e = err as Error & {
        stdout?: string;
        stderr?: string;
        status?: number;
      };
      const stderr = (e.stderr ?? e.message).toString();
      const stdout = (e.stdout ?? "").toString();
      const exitCode = typeof e.status === "number" ? e.status : 1;
      const result: CommandResult = {
        success: false,
        stdout,
        stderr,
        exitCode,
        error: "Command failed",
        executedIn: cwd,
      };
      this.addToHistory(conversationId, trimmed, result);
      return result;
    }
  }

  async git(args: string, conversationId: string): Promise<CommandResult> {
    // Route through executeShell but prefix with `git`.
    return this.executeShell(`git ${args}`, conversationId);
  }
}
