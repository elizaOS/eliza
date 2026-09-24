/**
 * Direct unit coverage for `registerStartCommand`. Drives a real Commander
 * program: start/run registration order, `--connection-key` option branches,
 * start-only docs help, loopback vs network auto-token, and the ready banner.
 * `startEliza` is stubbed so the suite never boots a live server; token writes
 * and console output come from the registrar itself.
 */
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installServerOnlyProcessOwner } from "../../runtime/server-only-process";
import { registerStartCommand } from "./register.start";

const startEliza = vi.hoisted(() => vi.fn(async (_opts: unknown) => undefined));
const pairing = vi.hoisted(() => ({
  next: null as { code: string; expiresAt: number } | null,
}));

vi.mock("../../runtime/eliza", () => ({
  startEliza,
}));

vi.mock("../../api/auth-pairing-routes", () => ({
  ensureAuthPairingCodeForRemoteAccess: () => pairing.next,
}));

const ENV_KEYS = [
  "ELIZA_API_TOKEN",
  "ELIZA_API_BIND",
  "ELIZA_DISABLE_AUTO_API_TOKEN",
  "ELIZA_PORT",
  "ELIZA_UI_PORT",
  "ELIZA_PAIRING_DISABLED",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_BOOT_PROFILE",
] as const;

type SavedEnv = Record<(typeof ENV_KEYS)[number], string | undefined>;

let savedEnv: SavedEnv;
const logs: string[] = [];

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerStartCommand(program);
  for (const command of program.commands) {
    command.exitOverride();
  }
  return program;
}

function commandNames(program: Command): string[] {
  return program.commands.map((command) => command.name());
}

function findCommand(program: Command, name: string): Command | undefined {
  return program.commands.find((command) => command.name() === name);
}

function captureOutputHelp(command: Command): string {
  const chunks: string[] = [];
  command.configureOutput({
    writeOut: (str) => {
      chunks.push(str);
    },
    writeErr: () => undefined,
  });
  command.outputHelp();
  return chunks.join("");
}

async function parseUser(
  args: string[],
  program: Command = createProgram(),
): Promise<Command> {
  await program.parseAsync(args, { from: "user" });
  return program;
}

function startCall(): {
  serverOnly?: boolean;
  onServerOnlyHostReady?: unknown;
  onEmbeddingProgress?: (phase: string, detail?: string) => void;
} {
  expect(startEliza).toHaveBeenCalledTimes(1);
  return startEliza.mock.calls[0]?.[0] as {
    serverOnly?: boolean;
    onServerOnlyHostReady?: unknown;
    onEmbeddingProgress?: (phase: string, detail?: string) => void;
  };
}

beforeEach(() => {
  savedEnv = {} as SavedEnv;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ELIZA_PAIRING_DISABLED = "1";
  logs.length = 0;
  pairing.next = null;
  startEliza.mockClear();
  startEliza.mockImplementation(async () => undefined);
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  vi.restoreAllMocks();
});

describe("registerStartCommand", () => {
  it("appends start then run onto an empty program, not a commander alias", () => {
    const program = createProgram();
    const start = findCommand(program, "start");
    const run = findCommand(program, "run");

    expect(commandNames(program)).toEqual(["start", "run"]);
    expect(start?.description()).toBe("Start the elizaOS agent runtime");
    expect(run?.description()).toBe("Alias for start");
    expect(start?.aliases()).toEqual([]);
    expect(run?.aliases()).toEqual([]);
    expect(findCommand(program, "missing")).toBeUndefined();
  });

  it("preserves existing commands and appends start/run after them", () => {
    const program = new Command();
    program.command("seed");
    registerStartCommand(program);
    expect(commandNames(program)).toEqual(["seed", "start", "run"]);
  });

  it("wires --connection-key [key] on both start and run", () => {
    const program = createProgram();
    for (const name of ["start", "run"] as const) {
      const command = findCommand(program, name);
      expect(command?.options.map((option) => option.flags)).toEqual([
        "--connection-key [key]",
      ]);
    }
  });

  it("attaches the getting-started docs block only to start help", () => {
    const program = createProgram();
    const startHelp = captureOutputHelp(
      findCommand(program, "start") as Command,
    );
    const runHelp = captureOutputHelp(findCommand(program, "run") as Command);

    expect(startHelp).toContain("Docs:");
    expect(startHelp).toContain("docs.eliza.ai/getting-started");
    expect(runHelp).not.toContain("Docs:");
    expect(runHelp).not.toContain("docs.eliza.ai/getting-started");
  });

  it("stores an explicit --connection-key value as ELIZA_API_TOKEN", async () => {
    await parseUser(["start", "--connection-key", "explicit-token-value"]);
    expect(process.env.ELIZA_API_TOKEN).toBe("explicit-token-value");
    expect(startCall().serverOnly).toBe(true);
  });

  it("treats --connection-key true as a literal token, not the bare flag", async () => {
    await parseUser(["start", "--connection-key", "true"]);
    expect(process.env.ELIZA_API_TOKEN).toBe("true");
  });

  it("generates a 32-char hex token when --connection-key is bare", async () => {
    await parseUser(["start", "--connection-key"]);
    expect(process.env.ELIZA_API_TOKEN).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates a different token on each bare --connection-key invocation", async () => {
    await parseUser(["start", "--connection-key"]);
    const first = process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_API_TOKEN;
    startEliza.mockClear();
    await parseUser(["run", "--connection-key"]);
    const second = process.env.ELIZA_API_TOKEN;
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
  });

  it("does not auto-generate a token on the default loopback bind", async () => {
    await parseUser(["start"]);
    expect(process.env.ELIZA_API_TOKEN).toBeUndefined();
  });

  it("does not auto-generate a token when binding localhost", async () => {
    process.env.ELIZA_API_BIND = "localhost";
    await parseUser(["start"]);
    expect(process.env.ELIZA_API_TOKEN).toBeUndefined();
  });

  it("auto-generates a token when binding a network address with none configured", async () => {
    process.env.ELIZA_API_BIND = "0.0.0.0";
    await parseUser(["start"]);
    expect(process.env.ELIZA_API_TOKEN).toMatch(/^[0-9a-f]{32}$/);
  });

  it("auto-generates a token for a non-loopback unicast bind", async () => {
    process.env.ELIZA_API_BIND = "10.1.2.3";
    await parseUser(["start"]);
    expect(process.env.ELIZA_API_TOKEN).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps an already-configured token on a network bind", async () => {
    process.env.ELIZA_API_BIND = "0.0.0.0";
    process.env.ELIZA_API_TOKEN = "already-configured-token";
    await parseUser(["start"]);
    expect(process.env.ELIZA_API_TOKEN).toBe("already-configured-token");
  });

  it("does not auto-generate when auto-token is disabled on a network bind", async () => {
    process.env.ELIZA_API_BIND = "0.0.0.0";
    process.env.ELIZA_DISABLE_AUTO_API_TOKEN = "1";
    await parseUser(["start"]);
    expect(process.env.ELIZA_API_TOKEN).toBeUndefined();
  });

  it("still honors an explicit key when auto-token is disabled", async () => {
    process.env.ELIZA_API_BIND = "0.0.0.0";
    process.env.ELIZA_DISABLE_AUTO_API_TOKEN = "1";
    await parseUser(["start", "--connection-key", "forced-key"]);
    expect(process.env.ELIZA_API_TOKEN).toBe("forced-key");
  });

  it("boots server-only and hands the process owner to startEliza", async () => {
    await parseUser(["start"]);
    const opts = startCall();
    expect(opts.serverOnly).toBe(true);
    expect(opts.onServerOnlyHostReady).toBe(installServerOnlyProcessOwner);
    expect(typeof opts.onEmbeddingProgress).toBe("function");
  });

  it("run invokes the same server-only boot path as start", async () => {
    await parseUser(["run"]);
    expect(startCall().serverOnly).toBe(true);
  });

  it("prints the default localhost URL with the default server-only port", async () => {
    await parseUser(["start"]);
    expect(logs.join("\n")).toContain(
      "Connect at: http://localhost:2138         ",
    );
    expect(logs.join("\n")).toContain("Server is running.");
  });

  it("pads a custom ELIZA_PORT into the boxed URL line", async () => {
    process.env.ELIZA_PORT = "9999";
    await parseUser(["start"]);
    expect(logs.join("\n")).toContain(
      "Connect at: http://localhost:9999         ",
    );
  });

  it("masks a connection key in the banner, leaving only the last four characters", async () => {
    await parseUser(["start", "--connection-key", "abcdefghij"]);
    const banner = logs.join("\n");
    expect(banner).toContain("Connection key: ******ghij            ");
    expect(banner).not.toContain("abcdefghij");
  });

  it("omits the connection-key banner line when no token is configured", async () => {
    await parseUser(["start"]);
    expect(logs.join("\n")).not.toContain("Connection key:");
  });

  it("pads a pairing code into the boxed banner when pairing is present", async () => {
    pairing.next = { code: "WXYZ-ABCD-EFGH", expiresAt: 1 };
    await parseUser(["start", "--connection-key", "pairing-token"]);
    expect(logs.join("\n")).toContain("Pairing code: WXYZ-ABCD-EFGH          ");
  });

  it("omits the pairing code line when pairing is absent", async () => {
    pairing.next = null;
    await parseUser(["start", "--connection-key", "pairing-token"]);
    expect(logs.join("\n")).not.toContain("Pairing code:");
  });

  it("logs embedding download and ready, and ignores other phases", async () => {
    await parseUser(["start"]);
    logs.length = 0;
    const progress = startCall().onEmbeddingProgress;
    expect(progress).toBeDefined();
    progress?.("downloading", "model.bin 40%");
    progress?.("downloading");
    progress?.("ready");
    progress?.("loading", "should-not-log");
    expect(logs).toEqual([
      "[eliza] Embedding: model.bin 40%",
      "[eliza] Embedding: downloading...",
      "[eliza] Embedding model ready",
    ]);
  });
});
