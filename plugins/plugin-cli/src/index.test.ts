/**
 * Exercises the plugin's public program surface — buildProgram, runCli, and
 * command registration through the Commander root. Deterministic: commands and
 * runtime are stubbed with vitest, no live model or process spawning.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildProgram,
	clearCliCommands,
	defineCliCommand,
	registerCliCommand,
	runCli,
} from "./index.js";

describe("plugin-cli program surface", () => {
	beforeEach(() => {
		clearCliCommands();
	});

	it("builds a Commander program and registers command callbacks with context", () => {
		const getRuntime = vi.fn(() => ({ agentId: "agent-1" }) as never);
		const register = vi.fn((ctx) => {
			ctx.program.command("hello").description("Say hello");
			expect(ctx.cliName).toBe("agent");
			expect(ctx.version).toBe("2.3.4");
			expect(ctx.getRuntime?.()).toEqual({ agentId: "agent-1" });
		});
		registerCliCommand(defineCliCommand("hello", "Say hello", register));

		const program = buildProgram({
			name: "agent",
			version: "2.3.4",
			getRuntime,
		});

		expect(program.name()).toBe("agent");
		expect(program.version()).toBe("2.3.4");
		expect(program.commands.map((command) => command.name())).toContain(
			"hello",
		);
		expect(register).toHaveBeenCalledTimes(1);
	});

	it("runCli executes registered command actions", async () => {
		const action = vi.fn();
		registerCliCommand(
			defineCliCommand("ping", "Ping", (ctx) => {
				ctx.program.command("ping").action(action);
			}),
		);

		await runCli(["node", "elizaos", "ping"]);

		expect(action).toHaveBeenCalledTimes(1);
	});

	it("runCli propagates command action failures", async () => {
		registerCliCommand(
			defineCliCommand("explode", "Explode", (ctx) => {
				ctx.program.command("explode").action(() => {
					throw new Error("boom");
				});
			}),
		);

		await expect(runCli(["node", "elizaos", "explode"])).rejects.toThrow(
			"boom",
		);
	});

	it("runCli returns for help and version instead of exiting the host process", async () => {
		const write = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		await expect(
			runCli(["node", "elizaos", "--help"]),
		).resolves.toBeUndefined();
		await expect(
			runCli(["node", "elizaos", "--version"], { version: "9.9.9" }),
		).resolves.toBeUndefined();

		expect(write).toHaveBeenCalled();
		write.mockRestore();
	});
});
