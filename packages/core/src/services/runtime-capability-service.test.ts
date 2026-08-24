/**
 * Covers RuntimeCapabilityService strategy-table routing: first-match-wins
 * dispatch per capability, per-capability fallback when a strategy omits the
 * requested capability, live setStrategies/setFallback replacement, fallback
 * delegation of availability, and the Service lifecycle defaults. Deterministic
 * unit suite — drives the real service and the real
 * UnavailableCapabilityRouter; no module mocks and no I/O.
 */
import { describe, expect, it } from "vitest";
import {
	CAPABILITY_ROUTER_SERVICE_TYPE,
	type CapabilityEnvironment,
	CapabilityError,
	type ElizaCapabilityRouter,
	type FileCapability,
	type GitCapability,
	type LocalModelCapability,
	type RemotePluginCapability,
	type TerminalCapability,
} from "../capabilities/index.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import {
	type CapabilityStrategy,
	RuntimeCapabilityService,
} from "./runtime-capability-service.ts";

// The service never dereferences its runtime; the base Service constructor
// merely stores it.
const createRuntime = () => ({}) as unknown as IAgentRuntime;

// Routing probes return tag-marked results so a driven call proves which
// strategy's implementation the service handed out.
function probeFs(tag: string): FileCapability {
	return {
		list: async () => ({
			root: {},
			path: `/${tag}`,
			entries: [],
			truncated: false,
			totalAfterIgnore: 0,
		}),
		readText: async (params) => ({
			path: params.path,
			text: `${tag}:${params.path}`,
			size: params.path.length,
			truncated: false,
		}),
		writeText: async (params) => ({ bytesWritten: params.text.length }),
	};
}

function probeTerminal(tag: string): TerminalCapability {
	return {
		runCommand: async (params) => ({
			output: `${tag}:${params.command}`,
			exitCode: 0,
			timedOut: false,
		}),
	};
}

function probeGit(tag: string): GitCapability {
	return {
		status: async (params) => ({
			repo: {},
			files: [],
			raw: `${tag}:${params.root}`,
		}),
		diff: async () => ({ raw: `${tag}:diff` }),
		commandRun: async () => ({
			operation: {
				id: `${tag}-op`,
				name: "status",
				cwd: ".",
				command: ["git", "status"],
				status: "completed",
				stdout: "",
				stderr: "",
				startedAt: "2026-01-01T00:00:00.000Z",
			},
		}),
	};
}

function probeModel(tag: string): LocalModelCapability {
	return { status: async () => ({ ok: true, provider: tag }) };
}

// Routing identity is the behaviour under test for the plugin getter; the
// heavyweight decode contract belongs to the remote-runner suite.
function probePlugin(): RemotePluginCapability {
	return {
		listModules: async () => ({ modules: [] }),
	} as unknown as RemotePluginCapability;
}

function strategy(options: {
	id: string;
	environment: CapabilityEnvironment;
	fs?: boolean;
	pty?: boolean;
	git?: boolean;
	model?: boolean;
	plugin?: boolean;
}): CapabilityStrategy {
	const entry: CapabilityStrategy = {
		id: options.id,
		environment: options.environment,
		availability: async () => ({
			environment: options.environment,
			available: true,
			capabilities: {
				fs: true,
				pty: true,
				git: true,
				model: true,
				plugin: true,
			},
		}),
	};
	if (options.fs) entry.fs = probeFs(options.id);
	if (options.pty) entry.pty = probeTerminal(options.id);
	if (options.git) entry.git = probeGit(options.id);
	if (options.model) entry.model = probeModel(options.id);
	if (options.plugin) entry.plugin = probePlugin();
	return entry;
}

function fallbackRouter(
	environment: CapabilityEnvironment,
	tag: string,
): ElizaCapabilityRouter {
	return {
		environment,
		availability: async () => ({
			environment,
			available: false,
			capabilities: {
				fs: false,
				pty: false,
				git: false,
				model: false,
				plugin: false,
			},
			reason: `${tag}-unavailable`,
		}),
		fs: probeFs(tag),
		pty: probeTerminal(tag),
		git: probeGit(tag),
		model: probeModel(tag),
		plugin: probePlugin(),
	};
}

describe("RuntimeCapabilityService", () => {
	it("registers under the capability-router service type", () => {
		expect(RuntimeCapabilityService.serviceType).toBe(
			CAPABILITY_ROUTER_SERVICE_TYPE,
		);
	});

	it("describes itself as the unified capability router", () => {
		const service = new RuntimeCapabilityService(createRuntime());
		expect(service.capabilityDescription).toContain(
			"Unified capability router",
		);
	});

	it("defaults to an unavailable unknown fallback when built without options", async () => {
		const service = new RuntimeCapabilityService(createRuntime());
		expect(service.environment).toBe("unknown");
		await expect(service.availability()).resolves.toEqual({
			environment: "unknown",
			available: false,
			capabilities: {
				fs: false,
				pty: false,
				git: false,
				model: false,
				plugin: false,
			},
			reason: "no-capability-strategy-configured",
		});
	});

	it("fails capability calls through the default fallback with a structured CapabilityError", async () => {
		const service = new RuntimeCapabilityService(createRuntime());
		const error = await service.fs.readText({ path: "/tmp/plan.md" }).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(CapabilityError);
		expect(error).toMatchObject({
			code: "CAPABILITY_UNAVAILABLE",
			message: "no-capability-strategy-configured",
			capability: "fs",
			method: "fs.readText",
		});
	});

	it("dispatches each capability to the first strategy that provides it", async () => {
		const first = strategy({
			id: "first",
			environment: "desktop",
			fs: true,
			model: true,
		});
		const second = strategy({
			id: "second",
			environment: "node",
			pty: true,
			git: true,
			plugin: true,
		});
		const service = new RuntimeCapabilityService(createRuntime(), {
			strategies: [first, second],
		});

		expect(service.fs).toBe(first.fs);
		expect(service.model).toBe(first.model);
		expect(service.pty).toBe(second.pty);
		expect(service.git).toBe(second.git);
		expect(service.plugin).toBe(second.plugin);
		await expect(
			service.fs.readText({ path: "/tmp/plan.md" }),
		).resolves.toEqual({
			path: "/tmp/plan.md",
			text: "first:/tmp/plan.md",
			size: "/tmp/plan.md".length,
			truncated: false,
		});
		await expect(service.model.status()).resolves.toEqual({
			ok: true,
			provider: "first",
		});
	});

	it("falls back per capability and keeps the leading strategy's environment", async () => {
		const local = strategy({
			id: "local",
			environment: "desktop",
			fs: true,
		});
		const fallback = fallbackRouter("server", "host");
		const service = new RuntimeCapabilityService(createRuntime(), {
			strategies: [local],
			fallback,
		});

		expect(service.fs).toBe(local.fs);
		expect(service.pty).toBe(fallback.pty);
		expect(service.git).toBe(fallback.git);
		expect(service.model).toBe(fallback.model);
		expect(service.plugin).toBe(fallback.plugin);
		await expect(
			service.pty.runCommand({ command: "echo hi" }),
		).resolves.toEqual({
			output: "host:echo hi",
			exitCode: 0,
			timedOut: false,
		});
		expect(service.environment).toBe("desktop");
	});

	it("uses a lone strategy for every capability it provides", async () => {
		const only = strategy({
			id: "only",
			environment: "mobile",
			fs: true,
			pty: true,
			git: true,
			model: true,
			plugin: true,
		});
		const service = new RuntimeCapabilityService(createRuntime(), {
			strategies: [only],
		});

		expect(service.fs).toBe(only.fs);
		expect(service.pty).toBe(only.pty);
		expect(service.git).toBe(only.git);
		expect(service.model).toBe(only.model);
		expect(service.plugin).toBe(only.plugin);
		expect(service.environment).toBe("mobile");
	});

	it("replaces the strategy table at runtime in both directions", async () => {
		const service = new RuntimeCapabilityService(createRuntime());
		const replacement = strategy({
			id: "late-plugin",
			environment: "node",
			fs: true,
		});

		service.setStrategies([replacement]);
		expect(service.fs).toBe(replacement.fs);
		expect(service.environment).toBe("node");

		service.setStrategies([]);
		expect(service.environment).toBe("unknown");
		const error = await service.fs.readText({ path: "/tmp/a" }).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(CapabilityError);
	});

	it("delegates availability to the fallback even when strategies are configured", async () => {
		const capable = strategy({
			id: "capable",
			environment: "desktop",
			fs: true,
		});
		const service = new RuntimeCapabilityService(createRuntime(), {
			strategies: [capable],
		});

		await expect(service.availability()).resolves.toEqual({
			environment: "unknown",
			available: false,
			capabilities: {
				fs: false,
				pty: false,
				git: false,
				model: false,
				plugin: false,
			},
			reason: "no-capability-strategy-configured",
		});
	});

	it("honors setFallback replacements", async () => {
		const service = new RuntimeCapabilityService(createRuntime());
		const replacement = fallbackRouter("server", "patched");

		service.setFallback(replacement);
		expect(service.environment).toBe("server");
		expect(service.model).toBe(replacement.model);
		await expect(service.availability()).resolves.toEqual({
			environment: "server",
			available: false,
			capabilities: {
				fs: false,
				pty: false,
				git: false,
				model: false,
				plugin: false,
			},
			reason: "patched-unavailable",
		});
	});

	it("starts through the Service lifecycle with default configuration", async () => {
		const service = await RuntimeCapabilityService.start(createRuntime());
		expect(service).toBeInstanceOf(RuntimeCapabilityService);
		expect(service.environment).toBe("unknown");
		await expect(service.availability()).resolves.toMatchObject({
			available: false,
		});
		await expect(service.stop()).resolves.toBeUndefined();
	});
});
