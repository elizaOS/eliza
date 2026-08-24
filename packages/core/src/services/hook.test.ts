/**
 * HookService unit coverage beyond ordering and event enumeration: registration
 * identity and defaults, single/multi-event indexing, unregister, enable and
 * priority mutation (including unknown-id guards), sequential payload delivery,
 * requirement-gated dispatch, the eligibility/requirements matrix, snapshot
 * versioning, teardown, and the unsupported directory loader. Drives the real
 * service through the event interceptor installed on a minimal fake runtime;
 * no model, no DB.
 */
import { describe, expect, it } from "vitest";
import { EventType } from "../types/events";
import { DEFAULT_HOOK_PRIORITY } from "../types/hook";
import type { IAgentRuntime } from "../types/runtime";
import { HookService, HookServiceClass } from "./hook";

type Interceptor = (payload: unknown) => Promise<void>;

function makeRuntime(sink: Map<string, Interceptor>): IAgentRuntime {
	const noop = () => {};
	return {
		agentId: "00000000-0000-0000-0000-0000000000aa",
		logger: { debug: noop, info: noop, warn: noop, error: noop, trace: noop },
		registerEvent: (eventType: string, handler: Interceptor) => {
			sink.set(eventType, handler);
		},
	} as unknown as IAgentRuntime;
}

async function makeService(): Promise<{
	service: HookService;
	fire: (event: EventType, payload?: unknown) => Promise<void>;
}> {
	const interceptors = new Map<string, Interceptor>();
	const service = await HookService.start(makeRuntime(interceptors));
	return {
		service,
		fire: async (event: EventType, payload: unknown = {}) => {
			const interceptor = interceptors.get(event as unknown as string);
			if (!interceptor) throw new Error(`no interceptor for ${event}`);
			await interceptor(payload);
		},
	};
}

describe("HookService registration identity", () => {
	it("mints unique ids whose suffix slugs the hook name", async () => {
		const { service } = await makeService();
		const first = service.register(EventType.HOOK_TOOL_BEFORE, () => {}, {
			name: "My Hook",
		});
		const second = service.register(EventType.HOOK_TOOL_BEFORE, () => {}, {
			name: "My Hook",
		});

		expect(first).not.toBe(second);
		expect(first).toMatch(/^hook_\d+_my_hook$/);
		expect(second).toMatch(/^hook_\d+_my_hook$/);
		expect(Number.parseInt(first.split("_")[1], 10)).toBeLessThan(
			Number.parseInt(second.split("_")[1], 10),
		);
	});

	it("collapses whitespace runs in the name slug", async () => {
		const { service } = await makeService();
		const id = service.register(EventType.HOOK_TOOL_BEFORE, () => {}, {
			name: "spaced   out\tname",
		});
		expect(id).toBe("hook_1_spaced_out_name");
	});

	it("defaults source to runtime and preserves source/plugin overrides", async () => {
		const { service } = await makeService();
		const defaultSource = service.register(
			EventType.HOOK_TOOL_BEFORE,
			() => {},
			{
				name: "defaulted",
			},
		);
		const plugin = service.register(EventType.HOOK_TOOL_AFTER, () => {}, {
			name: "pluginized",
			source: "plugin",
			pluginId: "test-plugin",
		});

		expect(service.getHook(defaultSource)?.metadata.source).toBe("runtime");
		expect(service.getHook(plugin)?.metadata.source).toBe("plugin");
		expect(service.getHook(plugin)?.metadata.pluginId).toBe("test-plugin");
		expect(service.getHook(defaultSource)?.metadata.enabled).toBe(true);
	});

	it("indexes single-event and multi-event registrations", async () => {
		const { service } = await makeService();
		const single = service.register(EventType.HOOK_TOOL_BEFORE, () => {}, {
			name: "single",
		});
		const multi = service.register(
			[EventType.HOOK_SESSION_START, EventType.HOOK_SESSION_END],
			() => {},
			{ name: "multi" },
		);

		expect(service.getHooksByEvent(EventType.HOOK_TOOL_BEFORE)).toEqual([
			service.getHook(single),
		]);
		expect(
			service.getHooksByEvent(EventType.HOOK_SESSION_START).map((r) => r.id),
		).toEqual([multi]);
		expect(
			service.getHooksByEvent(EventType.HOOK_SESSION_END).map((r) => r.id),
		).toEqual([multi]);
		// Unregistered event type hits the empty-index branch.
		expect(service.getHooksByEvent(EventType.HOOK_GATEWAY_START)).toEqual([]);
	});
});

describe("HookService unregister", () => {
	it("removes a multi-event hook from every indexed event and dispatch", async () => {
		const { service, fire } = await makeService();
		let calls = 0;
		const id = service.register(
			[EventType.HOOK_SESSION_START, EventType.HOOK_SESSION_END],
			() => {
				calls++;
			},
			{ name: "removable" },
		);

		expect(service.unregister(id)).toBe(true);
		expect(service.getHook(id)).toBeUndefined();
		expect(service.getHooksByEvent(EventType.HOOK_SESSION_START)).toEqual([]);
		expect(service.getHooksByEvent(EventType.HOOK_SESSION_END)).toEqual([]);

		await fire(EventType.HOOK_SESSION_START);
		await fire(EventType.HOOK_SESSION_END);
		expect(calls).toBe(0);
	});

	it("returns false for an unknown id", async () => {
		const { service } = await makeService();
		expect(service.unregister("hook_404_missing")).toBe(false);
	});
});

describe("HookService enable and priority mutation", () => {
	it("skips disabled hooks at dispatch until re-enabled", async () => {
		const { service, fire } = await makeService();
		let calls = 0;
		const id = service.register(
			EventType.HOOK_AGENT_START,
			() => {
				calls++;
			},
			{ name: "toggleable" },
		);

		service.setEnabled(id, false);
		await fire(EventType.HOOK_AGENT_START);
		expect(calls).toBe(0);

		service.setEnabled(id, true);
		await fire(EventType.HOOK_AGENT_START);
		expect(calls).toBe(1);
	});

	it("ignores enable/priority mutations for unknown ids", async () => {
		const { service } = await makeService();
		expect(service.getSnapshot().version).toBe(0);

		expect(() => service.setEnabled("hook_404_missing", false)).not.toThrow();
		expect(() => service.setPriority("hook_404_missing", 99)).not.toThrow();
		// Guards skip the snapshot-version increment too.
		expect(service.getSnapshot().version).toBe(0);
		expect(service.getAllHooks()).toEqual([]);
	});

	it("reorders dispatch when setPriority raises a later hook", async () => {
		const { service, fire } = await makeService();
		const seen: string[] = [];
		service.register(
			EventType.HOOK_AGENT_START,
			() => {
				seen.push("early-bird");
			},
			{ name: "early-bird", priority: 5 },
		);
		const late = service.register(
			EventType.HOOK_AGENT_START,
			() => {
				seen.push("risen");
			},
			{ name: "risen", priority: 1 },
		);

		service.setPriority(late, 10);
		await fire(EventType.HOOK_AGENT_START);
		expect(seen).toEqual(["risen", "early-bird"]);
	});

	it("normalizes a non-finite setPriority to the default in metadata", async () => {
		const { service } = await makeService();
		const id = service.register(EventType.HOOK_AGENT_START, () => {}, {
			name: "normalized",
			priority: 7,
		});

		service.setPriority(id, Number.POSITIVE_INFINITY);
		expect(service.getHook(id)?.metadata.priority).toBe(DEFAULT_HOOK_PRIORITY);

		const defaulted = service.register(EventType.HOOK_AGENT_START, () => {}, {
			name: "no-priority",
			priority: Number.NaN,
		});
		expect(service.getHook(defaulted)?.metadata.priority).toBe(
			DEFAULT_HOOK_PRIORITY,
		);
	});
});

describe("HookService dispatch", () => {
	it("resolves without error when no hooks match the fired event", async () => {
		const { service, fire } = await makeService();
		let calls = 0;
		service.register(
			EventType.HOOK_AGENT_END,
			() => {
				calls++;
			},
			{ name: "elsewhere" },
		);

		// An intercepted event with an empty index resolves as a no-op...
		await expect(fire(EventType.HOOK_GATEWAY_START)).resolves.toBeUndefined();
		expect(calls).toBe(0);

		// ...and the registered hook only sees its own event.
		await fire(EventType.HOOK_AGENT_END);
		expect(calls).toBe(1);
	});

	it("hands one shared payload to sequential handlers in priority order", async () => {
		const { service, fire } = await makeService();
		const read = (payload: unknown): { trail: string[] } =>
			payload as { trail: string[] };

		service.register(
			EventType.HOOK_MESSAGE_SENDING,
			(payload: unknown) => {
				read(payload).trail.push("first");
			},
			{ name: "first", priority: 2 },
		);
		service.register(
			EventType.HOOK_MESSAGE_SENDING,
			(payload: unknown) => {
				read(payload).trail.push(`second-saw-${read(payload).trail.join("+")}`);
			},
			{ name: "second", priority: 1 },
		);

		const payload = { trail: [] as string[] };
		await fire(EventType.HOOK_MESSAGE_SENDING, payload);
		expect(payload.trail).toEqual(["first", "second-saw-first"]);
	});

	it("skips hooks whose env requirement is unmet and runs them once met", async () => {
		const { service, fire } = await makeService();
		let calls = 0;
		service.register(
			EventType.HOOK_TOOL_BEFORE,
			() => {
				calls++;
			},
			{
				name: "env-gated",
				requires: { env: ["ELIZA_TEST_HOOK_REQUIRED_ENV"] },
			},
		);

		const previous = process.env.ELIZA_TEST_HOOK_REQUIRED_ENV;
		try {
			delete process.env.ELIZA_TEST_HOOK_REQUIRED_ENV;
			await fire(EventType.HOOK_TOOL_BEFORE);
			expect(calls).toBe(0);

			process.env.ELIZA_TEST_HOOK_REQUIRED_ENV = "1";
			await fire(EventType.HOOK_TOOL_BEFORE);
			expect(calls).toBe(1);
		} finally {
			process.env.ELIZA_TEST_HOOK_REQUIRED_ENV = previous;
		}
	});

	it("runs always-on hooks even with unsatisfiable binary requirements", async () => {
		const { service, fire } = await makeService();
		let gatedCalls = 0;
		let alwaysCalls = 0;

		service.register(
			EventType.HOOK_TOOL_AFTER,
			() => {
				gatedCalls++;
			},
			{
				name: "bin-gated",
				requires: { bins: ["eliza-test-binary-that-does-not-exist"] },
			},
		);
		service.register(
			EventType.HOOK_TOOL_AFTER,
			() => {
				alwaysCalls++;
			},
			{
				name: "always-on",
				always: true,
				requires: { bins: ["eliza-test-binary-that-does-not-exist"] },
			},
		);

		await fire(EventType.HOOK_TOOL_AFTER);
		expect(gatedCalls).toBe(0);
		expect(alwaysCalls).toBe(1);
	});

	it("gates dispatch on the service config set via setConfig", async () => {
		const { service, fire } = await makeService();
		let calls = 0;
		service.register(
			EventType.HOOK_TOOL_BEFORE,
			() => {
				calls++;
			},
			{
				name: "config-gated",
				requires: { config: ["features.hooks.enabled"] },
			},
		);

		service.setConfig({ features: { hooks: { enabled: true } } });
		await fire(EventType.HOOK_TOOL_BEFORE);
		expect(calls).toBe(1);

		service.setConfig({ features: { hooks: { enabled: false } } });
		await fire(EventType.HOOK_TOOL_BEFORE);
		expect(calls).toBe(1);

		service.setConfig({});
		await fire(EventType.HOOK_TOOL_BEFORE);
		expect(calls).toBe(1);
	});
});

describe("HookService eligibility API", () => {
	it("reports a specific result for an unknown hook id", async () => {
		const { service } = await makeService();
		expect(service.checkEligibility("hook_404_missing")).toEqual({
			eligible: false,
			reasons: ["Hook not found"],
		});
	});

	it("marks requirement-free hooks eligible", async () => {
		const { service } = await makeService();
		const id = service.register(EventType.HOOK_AGENT_END, () => {}, {
			name: "free",
		});
		expect(service.checkEligibility(id)).toEqual({ eligible: true });
	});

	it("evaluates OS requirements against the running platform", async () => {
		const { service } = await makeService();
		const here = process.platform;
		const elsewhere = here === "darwin" ? "linux" : "darwin";

		const okId = service.register(EventType.HOOK_AGENT_END, () => {}, {
			name: "os-ok",
			requires: { os: [here] },
		});
		const badId = service.register(EventType.HOOK_AGENT_END, () => {}, {
			name: "os-bad",
			requires: { os: [elsewhere] },
		});

		expect(service.checkEligibility(okId)).toEqual({ eligible: true });
		const badResult = service.checkEligibility(badId);
		expect(badResult.eligible).toBe(false);
		expect(badResult.reasons?.[0]).toContain(elsewhere);
		expect(badResult.reasons?.[0]).toContain(here);
	});

	it("reports every unmet requirement category with actionable reasons", async () => {
		const { service } = await makeService();
		const previous = process.env.ELIZA_TEST_HOOK_UNSET_ENV;
		try {
			delete process.env.ELIZA_TEST_HOOK_UNSET_ENV;
			const result = service.checkRequirements(
				{
					bins: ["missing-tool"],
					anyBins: ["also-missing-a", "also-missing-b"],
					env: ["ELIZA_TEST_HOOK_UNSET_ENV"],
					config: ["workspace.dir"],
				},
				// A truthy-but-empty config object keeps config paths in the check.
				{ workspace: {} },
			);

			expect(result.eligible).toBe(false);
			expect(result.reasons).toEqual([
				"Required binary 'missing-tool' not found",
				"None of required binaries found: also-missing-a, also-missing-b",
				"Required environment variable 'ELIZA_TEST_HOOK_UNSET_ENV' not set",
				"Required config path 'workspace.dir' is not truthy",
			]);
		} finally {
			process.env.ELIZA_TEST_HOOK_UNSET_ENV = previous;
		}
	});

	it("treats empty or absent requirement lists as eligible", async () => {
		const { service } = await makeService();
		expect(service.checkRequirements({})).toEqual({ eligible: true });
		expect(
			service.checkRequirements({
				os: [],
				bins: [],
				anyBins: [],
				env: [],
				config: [],
			}),
		).toEqual({ eligible: true });
	});

	it("honors set config values through dot-paths and truthiness rules", async () => {
		const { service } = await makeService();
		const config = {
			workspace: { dir: "/tmp/eliza" },
			flags: { count: 0, label: "   ", enabled: true, missing: null },
			scalar: 5,
		};

		expect(
			service.checkRequirements({ config: ["workspace.dir"] }, config).eligible,
		).toBe(true);
		expect(
			service.checkRequirements({ config: ["flags.enabled", "scalar"] }, config)
				.eligible,
		).toBe(true);
		expect(
			service.checkRequirements(
				{
					config: [
						"flags.count",
						"flags.label",
						"flags.missing",
						"scalar.nope",
						"scalar.nope.deeper",
					],
				},
				config,
			).reasons,
		).toEqual([
			"Required config path 'flags.count' is not truthy",
			"Required config path 'flags.label' is not truthy",
			"Required config path 'flags.missing' is not truthy",
			"Required config path 'scalar.nope' is not truthy",
			"Required config path 'scalar.nope.deeper' is not truthy",
		]);
	});

	it("skips config checks entirely when no config was provided", async () => {
		const { service } = await makeService();
		expect(service.checkRequirements({ config: ["anything.at.all"] })).toEqual({
			eligible: true,
		});
	});

	it("accepts a satisfied env requirement without listing reasons", async () => {
		const { service } = await makeService();
		const previous = process.env.ELIZA_TEST_HOOK_PRESENT_ENV;
		try {
			process.env.ELIZA_TEST_HOOK_PRESENT_ENV = "yes";
			const result = service.checkRequirements({
				env: ["ELIZA_TEST_HOOK_PRESENT_ENV"],
			});
			expect(result).toEqual({ eligible: true });
		} finally {
			process.env.ELIZA_TEST_HOOK_PRESENT_ENV = previous;
		}
	});
});

describe("HookService introspection and lifecycle", () => {
	it("summarizes metadata in snapshots and bumps the version on every change", async () => {
		const { service } = await makeService();
		expect(service.getSnapshot().version).toBe(0);

		const id = service.register(EventType.HOOK_COMPACTION_BEFORE, () => {}, {
			name: "snapshotted",
			source: "workspace",
			pluginId: "wp",
		});
		let snapshot = service.getSnapshot();
		expect(snapshot.version).toBe(1);
		expect(snapshot.hooks).toEqual([
			{
				name: "snapshotted",
				events: [EventType.HOOK_COMPACTION_BEFORE],
				source: "workspace",
				enabled: true,
				pluginId: "wp",
				priority: DEFAULT_HOOK_PRIORITY,
			},
		]);
		expect(snapshot.timestamp).toBeGreaterThan(0);

		service.setEnabled(id, false);
		expect(service.getSnapshot().version).toBe(2);
		service.setPriority(id, 3);
		expect(service.getSnapshot().version).toBe(3);
		expect(service.getHook(id)?.metadata.priority).toBe(3);

		service.unregister(id);
		expect(service.getSnapshot().version).toBe(4);
		expect(service.getSnapshot().hooks).toEqual([]);

		snapshot = service.getSnapshot();
		expect(typeof snapshot.timestamp).toBe("number");
	});

	it("stop() empties the registry and silences dispatch", async () => {
		const { service, fire } = await makeService();
		let calls = 0;
		service.register(
			EventType.HOOK_SESSION_END,
			() => {
				calls++;
			},
			{ name: "stopped" },
		);

		await service.stop();
		expect(service.getAllHooks()).toEqual([]);
		await fire(EventType.HOOK_SESSION_END);
		expect(calls).toBe(0);
	});

	it("refuses directory loading with an explicit unsupported error", async () => {
		const { service } = await makeService();
		await expect(
			service.registerFromDirectory("/tmp/hooks", "workspace"),
		).rejects.toThrow("registerFromDirectory is not supported");
	});

	it("exposes the class under its registration alias", () => {
		expect(HookServiceClass).toBe(HookService);
		expect(HookService.serviceType).toBeDefined();
	});
});
