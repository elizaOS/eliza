/**
 * Direct unit coverage for `registerUpdateCommand`. Drives a real Commander
 * program: empty registration, append-after-sibling order, option and
 * subcommand wiring, invalid/same/switch channel, voice-model listing from
 * the live catalog, and the update/status actions against an isolated config
 * and a stubbed npm fetch. `detectInstallMethod` and `performUpdate` are
 * fixtures so the suite never inspects this machine or runs an installer.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as agent from "@elizaos/agent";
import {
  latestVoiceModelVersion,
  theme,
  VOICE_MODEL_VERSIONS,
} from "@elizaos/shared";
import { Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_VERSION } from "../version";
import * as updateModule from "./register.update";
import { registerUpdateCommand } from "./register.update";

const ALL_CHANNELS = ["stable", "beta", "nightly"] as const;
const CHANNEL_DESCRIPTIONS = {
  stable: "Production-ready releases. Recommended for most users.",
  beta: "Release candidates. May contain minor issues.",
  nightly: "Latest development builds. May be unstable.",
} as const;
const NEWER_DIST_TAGS = {
  latest: "9999.9.9",
  beta: "9999.9.9-beta.1",
  nightly: "9999.9.9-nightly.1",
};

const ORIGINAL_ENV = {
  ELIZA_CONFIG_PATH: process.env.ELIZA_CONFIG_PATH,
  ELIZA_PERSIST_CONFIG_PATH: process.env.ELIZA_PERSIST_CONFIG_PATH,
  ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
  ELIZA_UPDATE_CHANNEL: process.env.ELIZA_UPDATE_CHANNEL,
};

const tempDirs: string[] = [];
const logs: string[] = [];
const errors: string[] = [];
const exits: number[] = [];
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
let distTags: Record<string, string> = { ...NEWER_DIST_TAGS };
let fetchOk = true;
let configPath = "";

function restoreEnv(key: keyof typeof ORIGINAL_ENV, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function isolateConfig(): void {
  const dir = mkdtempSync(path.join(tmpdir(), "register-update-"));
  tempDirs.push(dir);
  configPath = path.join(dir, "eliza.json");
  process.env.ELIZA_STATE_DIR = dir;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  delete process.env.ELIZA_UPDATE_CHANNEL;
}

function writeConfig(update?: {
  channel?: (typeof ALL_CHANNELS)[number];
  lastCheckAt?: string;
  lastCheckVersion?: string;
  lastCheckChannel?: (typeof ALL_CHANNELS)[number];
}): void {
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        logging: { level: "error" },
        ...(update ? { update } : {}),
      },
      null,
      2,
    )}\n`,
  );
}

function readConfig(): {
  update?: {
    channel?: string;
    lastCheckAt?: string;
    lastCheckVersion?: string;
    lastCheckChannel?: string;
  };
} {
  return JSON.parse(readFileSync(configPath, "utf8")) as ReturnType<
    typeof readConfig
  >;
}

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  return program;
}

function findCommand(program: Command, name: string): Command | undefined {
  return program.commands.find((command) => command.name() === name);
}

function uniqueVoiceIds(): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const version of VOICE_MODEL_VERSIONS) {
    if (seen.has(version.id)) continue;
    seen.add(version.id);
    ids.push(version.id);
  }
  return ids;
}

function voiceListingLine(id: string): string | undefined {
  const latest = latestVoiceModelVersion(id);
  if (!latest) return undefined;
  const sizeMb =
    latest.ggufAssets.length === 0
      ? "(unpublished)"
      : `${(latest.ggufAssets.reduce((sum, asset) => sum + asset.sizeBytes, 0) / 1_048_576).toFixed(1)} MB`;
  return `  ${theme.accent(id.padEnd(24))} ${theme.success(latest.version.padEnd(8))} ${theme.muted(sizeMb)}`;
}

async function parseUser(args: string[]): Promise<void> {
  const program = makeProgram();
  registerUpdateCommand(program);
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("process.exit:")) {
      return;
    }
    throw error;
  }
}

function parseUserArgs(program: Command, args: string[]): CommanderError {
  try {
    program.parse(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error;
    }
    throw error;
  }
  throw new Error(`parse(${JSON.stringify(args)}) returned without exiting`);
}

describe("registerUpdateCommand", () => {
  beforeEach(() => {
    isolateConfig();
    writeConfig({ channel: "stable" });
    logs.length = 0;
    errors.length = 0;
    exits.length = 0;
    fetchCalls = 0;
    fetchOk = true;
    distTags = { ...NEWER_DIST_TAGS };

    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code ?? 0);
      throw new Error(`process.exit:${code ?? 0}`);
    }) as typeof process.exit);
    vi.spyOn(agent, "detectInstallMethod").mockReturnValue("local-dev");
    vi.spyOn(agent, "performUpdate").mockRejectedValue(
      new Error("performUpdate must not run unless a test opts in"),
    );
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (!fetchOk) {
        throw new Error("network down");
      }
      return {
        ok: true,
        json: async () => ({ "dist-tags": distTags }),
      };
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    for (const key of Object.keys(ORIGINAL_ENV) as Array<
      keyof typeof ORIGINAL_ENV
    >) {
      restoreEnv(key, ORIGINAL_ENV[key]);
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports only registerUpdateCommand", () => {
    expect(Object.keys(updateModule)).toEqual(["registerUpdateCommand"]);
    expect(typeof registerUpdateCommand).toBe("function");
  });

  it("registers a single update command on an empty program", () => {
    const program = makeProgram();
    expect(program.commands).toEqual([]);

    registerUpdateCommand(program);

    expect(program.commands.map((command) => command.name())).toEqual([
      "update",
    ]);
    const update = findCommand(program, "update");
    expect(update).toBeDefined();
    expect(update?.description()).toBe("Check for and install updates");
    expect(update?.alias()).toBeUndefined();
    expect(update?.aliases()).toEqual([]);
    expect(update?.options.map((option) => option.flags)).toEqual([
      "-c, --channel <channel>",
      "--check",
      "--force",
      "--voice-models",
    ]);
    expect(update?.commands.map((command) => command.name())).toEqual([
      "status",
      "channel",
    ]);
  });

  it("does not register a missing sibling name", () => {
    const program = makeProgram();
    registerUpdateCommand(program);

    expect(findCommand(program, "upgrade")).toBeUndefined();
    expect(findCommand(program, "updates")).toBeUndefined();
    expect(findCommand(program, "")).toBeUndefined();
  });

  it("appends update after an already-registered sibling", () => {
    const program = makeProgram();
    program.command("db").description("Database helpers");

    registerUpdateCommand(program);

    expect(program.commands.map((command) => command.name())).toEqual([
      "db",
      "update",
    ]);
    expect(findCommand(program, "db")?.description()).toBe("Database helpers");
  });

  it("does not print anything merely by registering the command", () => {
    registerUpdateCommand(makeProgram());
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
    expect(existsSync(configPath)).toBe(true);
  });

  it("wires status and optional channel subcommands", () => {
    const program = makeProgram();
    registerUpdateCommand(program);
    const update = findCommand(program, "update");
    const status = update?.commands.find(
      (command) => command.name() === "status",
    );
    const channel = update?.commands.find(
      (command) => command.name() === "channel",
    );

    expect(status?.description()).toBe(
      "Show current version and available updates across all channels",
    );
    expect(status?.options).toEqual([]);
    expect(channel?.description()).toBe("View or change the release channel");
    expect(
      channel?.registeredArguments.map((argument) => argument.name()),
    ).toEqual(["channel"]);
    expect(channel?.registeredArguments[0]?.required).toBe(false);
  });

  it("prints usage, flags, and subcommands from update --help", () => {
    const { program, out } = (() => {
      const out: string[] = [];
      const program = new Command();
      program.exitOverride();
      program.configureOutput({
        writeOut: (chunk) => {
          out.push(chunk);
        },
        writeErr: () => undefined,
      });
      registerUpdateCommand(program);
      return { program, out };
    })();

    const error = parseUserArgs(program, ["update", "--help"]);
    expect(error.code).toBe("commander.helpDisplayed");

    const help = out.join("");
    expect(help).toContain("Usage:");
    expect(help).toContain("Check for and install updates");
    expect(help).toMatch(/-c, --channel/);
    expect(help).toContain("--check");
    expect(help).toContain("--force");
    expect(help).toContain("--voice-models");
    expect(help).toContain("status");
    expect(help).toContain("channel");
  });

  it("rejects an unknown option on update", () => {
    const program = makeProgram();
    registerUpdateCommand(program);

    const error = parseUserArgs(program, ["update", "--task"]);
    expect(error.code).toBe("commander.unknownOption");
    expect(error.message).toMatch(/--task/);
  });

  it("exits 1 for an invalid --channel value without writing config", async () => {
    const before = readFileSync(configPath, "utf8");
    await parseUser(["update", "--channel", "canary", "--check"]);

    expect(exits).toEqual([1]);
    expect(errors.join("\n")).toContain(
      'Invalid channel "canary". Valid channels: stable, beta, nightly',
    );
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(fetchCalls).toBe(0);
  });

  it("treats channel names as case-sensitive", async () => {
    await parseUser(["update", "channel", "STABLE"]);
    expect(exits).toEqual([1]);
    expect(errors.join("\n")).toContain('Invalid channel "STABLE"');
    expect(readConfig().update?.channel).toBe("stable");
  });

  it("prints the current channel and the ordered catalog when channel has no argument", async () => {
    writeConfig({ channel: "beta" });
    await parseUser(["update", "channel"]);

    const output = logs.join("\n");
    expect(output).toContain(theme.heading("Release Channel"));
    expect(output).toContain(`Current: ${theme.warn("beta")}`);
    expect(output).toContain(CHANNEL_DESCRIPTIONS.beta);
    expect(output).toContain(theme.accent(" (active)"));
    const listing = output.slice(output.indexOf("Available channels:"));
    expect(listing.indexOf(theme.success("stable"))).toBeLessThan(
      listing.indexOf(theme.warn("beta")),
    );
    expect(listing.indexOf(theme.warn("beta"))).toBeLessThan(
      listing.indexOf(theme.accent("nightly")),
    );
    expect(output).toContain(
      "Switch with: eliza update channel <stable|beta|nightly>",
    );
    expect(readConfig().update?.channel).toBe("beta");
    expect(exits).toEqual([]);
  });

  it("does not rewrite config when switching to the already-active channel", async () => {
    writeConfig({
      channel: "stable",
      lastCheckAt: "2026-01-01T00:00:00.000Z",
      lastCheckVersion: "1.0.0",
    });
    const before = readFileSync(configPath, "utf8");

    await parseUser(["update", "channel", "stable"]);

    expect(logs.join("\n")).toContain(
      `Already on ${theme.success("stable")} channel. No change needed.`,
    );
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(exits).toEqual([]);
  });

  it("writes a new channel and clears the check cache", async () => {
    writeConfig({
      channel: "stable",
      lastCheckAt: "2026-01-01T00:00:00.000Z",
      lastCheckVersion: "1.0.0",
      lastCheckChannel: "stable",
    });

    await parseUser(["update", "channel", "nightly"]);

    const output = logs.join("\n");
    expect(output).toContain(
      `Channel changed: ${theme.success("stable")} -> ${theme.accent("nightly")}`,
    );
    expect(output).toContain(CHANNEL_DESCRIPTIONS.nightly);
    expect(output).toContain(
      "Run `eliza update` to fetch the latest version from this channel.",
    );
    expect(readConfig().update?.channel).toBe("nightly");
    expect(readConfig().update?.lastCheckAt).toBeUndefined();
    expect(readConfig().update?.lastCheckVersion).toBeUndefined();
    expect(fetchCalls).toBe(0);
  });

  it("lists each unique live voice-model id once, including unpublished latest rows", async () => {
    const ids = uniqueVoiceIds();
    expect(ids.length).toBeGreaterThan(0);

    await parseUser(["update", "--voice-models"]);

    const output = logs.join("\n");
    expect(output).toContain(theme.heading("Eliza voice sub-models"));
    expect(output).toContain("VoiceModelUpdater");
    expect(output).not.toContain(
      "Run `eliza update --voice-models` without `--check` to apply updates.",
    );

    for (const id of ids) {
      const line = voiceListingLine(id);
      expect(line).toBeDefined();
      expect(output).toContain(line as string);
      const padded = theme.accent(id.padEnd(24));
      expect(output.split(padded).length - 1).toBe(1);
    }
    expect(fetchCalls).toBe(0);
    expect(agent.performUpdate).not.toHaveBeenCalled();
  });

  it("prints the apply hint instead of the runtime path when --voice-models --check", async () => {
    await parseUser(["update", "--voice-models", "--check"]);

    const output = logs.join("\n");
    expect(output).toContain(theme.heading("Eliza voice sub-models"));
    expect(output).toContain(
      "Run `eliza update --voice-models` without `--check` to apply updates.",
    );
    expect(output).not.toContain("VoiceModelUpdater");
  });

  it("honours ELIZA_UPDATE_CHANNEL over the on-disk channel when viewing", async () => {
    writeConfig({ channel: "stable" });
    process.env.ELIZA_UPDATE_CHANNEL = "beta";

    await parseUser(["update", "channel"]);

    const output = logs.join("\n");
    expect(output).toContain(`Current: ${theme.warn("beta")}`);
    expect(output).toContain(theme.accent(" (active)"));
    expect(readConfig().update?.channel).toBe("stable");
  });

  it("prints already-up-to-date when the dist-tag matches the agent version", async () => {
    distTags = {
      latest: agent.VERSION,
      beta: agent.VERSION,
      nightly: agent.VERSION,
    };

    await parseUser(["update", "--check"]);

    expect(fetchCalls).toBe(1);
    expect(logs.join("\n")).toContain(
      `Already up to date! (${CLI_VERSION} is the latest on stable)`,
    );
    expect(exits).toEqual([]);
    expect(agent.performUpdate).not.toHaveBeenCalled();
  });

  it("prints the install hint and does not install when --check sees a newer dist-tag", async () => {
    await parseUser(["update", "--check"]);

    const output = logs.join("\n");
    expect(output).toContain(theme.heading("Eliza Update"));
    expect(output).toContain(`(channel: stable)`);
    expect(output).toContain(`Current version: ${CLI_VERSION}`);
    expect(output).toContain(
      `${CLI_VERSION} -> ${theme.success(NEWER_DIST_TAGS.latest)}`,
    );
    expect(output).toContain("Run `eliza update` to install the update.");
    expect(agent.performUpdate).not.toHaveBeenCalled();
    expect(exits).toEqual([]);
  });

  it("exits 1 on a registry error unless --check is set", async () => {
    fetchOk = false;
    await parseUser(["update"]);
    expect(errors.join("\n")).toContain(
      "Unable to reach the npm registry. Check your network connection.",
    );
    expect(exits).toEqual([1]);

    exits.length = 0;
    errors.length = 0;
    await parseUser(["update", "--check"]);
    expect(errors.join("\n")).toContain(
      "Unable to reach the npm registry. Check your network connection.",
    );
    expect(exits).toEqual([]);
  });

  it("bypasses a fresh cache only when --force is set", async () => {
    writeConfig({
      channel: "stable",
      lastCheckAt: new Date().toISOString(),
      lastCheckVersion: agent.VERSION,
      lastCheckChannel: "stable",
    });

    await parseUser(["update", "--check"]);
    expect(fetchCalls).toBe(0);

    await parseUser(["update", "--check", "--force"]);
    expect(fetchCalls).toBe(1);
  });

  it("forces a live check when --channel is passed even if the channel is unchanged", async () => {
    writeConfig({
      channel: "stable",
      lastCheckAt: new Date().toISOString(),
      lastCheckVersion: agent.VERSION,
      lastCheckChannel: "stable",
    });

    await parseUser(["update", "--channel", "stable", "--check"]);
    expect(fetchCalls).toBe(1);
    expect(logs.join("\n")).not.toContain("Release channel changed");
  });

  it("records a channel switch on --channel before checking", async () => {
    await parseUser(["update", "--channel", "beta", "--check"]);

    expect(logs.join("\n")).toContain(
      `Release channel changed: ${theme.success("stable")} -> ${theme.warn("beta")}`,
    );
    expect(logs.join("\n")).toContain("(channel: beta)");
    expect(readConfig().update?.channel).toBe("beta");
    expect(fetchCalls).toBe(1);
  });

  it("prints the local-dev plan and does not call performUpdate when an update is available", async () => {
    const plan = agent.getUpdateActionPlan("local-dev", "stable");
    expect(plan.canExecuteFromContext).toBe(false);

    await parseUser(["update"]);

    expect(logs.join("\n")).toContain(plan.message);
    expect(agent.performUpdate).not.toHaveBeenCalled();
    expect(exits).toEqual([]);
  });

  it("installs through the real npm-global plan and prints the new version", async () => {
    vi.mocked(agent.detectInstallMethod).mockReturnValue("npm-global");
    vi.mocked(agent.performUpdate).mockResolvedValue({
      success: true,
      method: "npm-global",
      command: "npm install -g elizaos@latest",
      previousVersion: CLI_VERSION,
      newVersion: NEWER_DIST_TAGS.latest,
      error: null,
    });
    const plan = agent.getUpdateActionPlan("npm-global", "stable");
    expect(plan.canExecuteFromContext).toBe(true);

    await parseUser(["update"]);

    const output = logs.join("\n");
    expect(output).toContain(`Install method: npm-global`);
    expect(output).toContain(`Authority: ${plan.authority}`);
    expect(output).toContain(`Command: ${plan.command}`);
    expect(output).toContain(
      `Updated successfully! ${CLI_VERSION} -> ${NEWER_DIST_TAGS.latest}`,
    );
    expect(output).toContain(
      "Restart eliza for the new version to take effect.",
    );
    expect(agent.performUpdate).toHaveBeenCalledWith(
      CLI_VERSION,
      "stable",
      "npm-global",
    );
    expect(exits).toEqual([]);
  });

  it("warns when the installer succeeds but cannot verify the version", async () => {
    vi.mocked(agent.detectInstallMethod).mockReturnValue("npm-global");
    vi.mocked(agent.performUpdate).mockResolvedValue({
      success: true,
      method: "npm-global",
      command: "npm install -g elizaos@latest",
      previousVersion: CLI_VERSION,
      newVersion: null,
      error: null,
    });

    await parseUser(["update"]);

    const output = logs.join("\n");
    expect(output).toContain("Update command completed successfully.");
    expect(output).toContain(
      `Could not verify the new version. Expected: ${NEWER_DIST_TAGS.latest}`,
    );
    expect(exits).toEqual([]);
  });

  it("exits 1 and prints the manual command when performUpdate fails", async () => {
    vi.mocked(agent.detectInstallMethod).mockReturnValue("npm-global");
    vi.mocked(agent.performUpdate).mockResolvedValue({
      success: false,
      method: "npm-global",
      command: "npm install -g elizaos@latest",
      previousVersion: CLI_VERSION,
      newVersion: null,
      error: "npm exploded",
    });

    await parseUser(["update"]);

    expect(errors.join("\n")).toContain("Update failed: npm exploded");
    expect(logs.join("\n")).toContain("Command: npm install -g elizaos@latest");
    expect(logs.join("\n")).toContain("You can try running it manually.");
    expect(exits).toEqual([1]);
  });

  it("lists every channel in source order and marks the current one", async () => {
    writeConfig({
      channel: "beta",
      lastCheckAt: "2026-01-02T03:04:05.000Z",
    });
    distTags = { latest: "1.0.0" };

    await parseUser(["update", "status"]);

    const output = logs.join("\n");
    expect(output).toContain(theme.heading("Version Status"));
    expect(output).toContain(`Installed:  ${theme.accent(CLI_VERSION)}`);
    expect(output).toContain(`Channel:    ${theme.warn("beta")}`);
    expect(output).toContain("Install:    ");
    expect(output).toContain("Can run:    no");
    expect(output).toContain(theme.heading("Available Versions"));
    expect(output).toContain("1.0.0");
    expect(output).toContain(theme.muted("(not published)"));
    expect(output).toContain(theme.accent(" <-- current"));
    expect(output).toContain("Last checked:");
    const versions = output.slice(output.indexOf("Available Versions"));
    expect(versions.indexOf(theme.success("stable"))).toBeLessThan(
      versions.indexOf(theme.warn("beta")),
    );
    expect(versions.indexOf(theme.warn("beta"))).toBeLessThan(
      versions.indexOf(theme.accent("nightly")),
    );
    expect(fetchCalls).toBe(1);
  });

  it("omits last-checked when the cache timestamp is missing", async () => {
    writeConfig({ channel: "stable" });
    await parseUser(["update", "status"]);
    expect(logs.join("\n")).not.toContain("Last checked:");
  });
});
