/**
 * Unit tests for CLI config command registration and command tree.
 */

import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerConfigCli } from "./register.config.js";

function makeProgram(): {
  program: Command;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: (chunk) => {
      out.push(chunk);
    },
    writeErr: (chunk) => {
      err.push(chunk);
    },
  });
  return { program, out, err };
}

describe("registerConfigCli", () => {
  it("registers the config command group and subcommands", () => {
    const { program } = makeProgram();
    expect(program.commands).toEqual([]);

    registerConfigCli(program);

    const configCmd = program.commands.find((cmd) => cmd.name() === "config");
    expect(configCmd).toBeDefined();
    expect(configCmd?.description()).toBe("Config helpers (get/path)");

    const subcommands = configCmd?.commands.map((cmd) => cmd.name());
    expect(subcommands).toEqual(["get", "path", "show"]);
  });

  it("registers get <key> with required argument", () => {
    const { program } = makeProgram();
    registerConfigCli(program);

    const configCmd = program.commands.find((cmd) => cmd.name() === "config");
    const getCmd = configCmd?.commands.find((cmd) => cmd.name() === "get");

    expect(getCmd).toBeDefined();
    expect(getCmd?.description()).toBe("Get a config value");
    expect(getCmd?.registeredArguments.map((arg) => arg.name())).toEqual([
      "key",
    ]);
  });

  it("registers path command", () => {
    const { program } = makeProgram();
    registerConfigCli(program);

    const configCmd = program.commands.find((cmd) => cmd.name() === "config");
    const pathCmd = configCmd?.commands.find((cmd) => cmd.name() === "path");

    expect(pathCmd).toBeDefined();
    expect(pathCmd?.description()).toBe("Print the resolved config file path");
  });

  it("registers show command with options", () => {
    const { program } = makeProgram();
    registerConfigCli(program);

    const configCmd = program.commands.find((cmd) => cmd.name() === "config");
    const showCmd = configCmd?.commands.find((cmd) => cmd.name() === "show");

    expect(showCmd).toBeDefined();
    expect(showCmd?.description()).toBe(
      "Display all configuration values grouped by section",
    );

    const optionFlags = showCmd?.options.map((opt) => opt.flags);
    expect(optionFlags).toContain("-a, --all");
    expect(optionFlags).toContain("--json");
  });
});
