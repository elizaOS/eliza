/**
 * Unit tests for catalog-command mapping into `DiscordSlashCommand`, dedupe
 * against built-ins, and per-target execute branching. Mocked runtime/registry.
 */
import type { Content, IAgentRuntime, Memory } from "@elizaos/core";
import { getConnectorCommands } from "@elizaos/plugin-commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits } from "discord.js";

// The connector bridge gates auth via the agent role model (`hasRoleAccess`).
// Mock it so each test controls the sender's resolved trust level without
// standing up a full world/role graph. The default returns true (lenient
// no-world path), matching real local-only behavior. `vi.hoisted` is required
// because `vi.mock` factories are hoisted above imports.
const { hasRoleAccess } = vi.hoisted(() => ({
	hasRoleAccess: vi.fn(async () => true),
}));
vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return { ...actual, hasRoleAccess };
});

import {
	buildCatalogSlashCommands,
	buildDiscordEmbedCommand,
	mapCatalogCommand,
	registerCatalogSlashCommands,
	resolveDiscordEmbedUrl,
} from "../catalog-commands";
import {
	getRegisteredCommands,
	removeCommand,
	type SlashCommand,
} from "../slash-commands";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

function makeRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
	const cache = new Map<string, unknown>();
	return {
		agentId: AGENT_ID,
		messageService: null,
		getCache: vi.fn(async (key: string) => cache.get(key)),
		setCache: vi.fn(async (key: string, value: unknown) => {
			cache.set(key, value);
			return true;
		}),
		deleteCache: vi.fn(async (key: string) => cache.delete(key)),
		getSetting: vi.fn(() => undefined),
		character: { name: "TestAgent" },
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
		...overrides,
	} as unknown as IAgentRuntime;
}

interface MockInteraction {
	id: string;
	channelId: string;
	user: { id: string; username: string };
	options: { getString: ReturnType<typeof vi.fn> };
	reply: ReturnType<typeof vi.fn>;
	deferReply: ReturnType<typeof vi.fn>;
	editReply: ReturnType<typeof vi.fn>;
}

function makeInteraction(
	stringOptions: Record<string, string | null> = {},
): MockInteraction {
	return {
		id: "interaction-1",
		channelId: "987654321098765432",
		user: { id: "123456789012345678", username: "tester" },
		options: {
			getString: vi.fn((name: string) => stringOptions[name] ?? null),
		},
		reply: vi.fn(async () => undefined),
		deferReply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
	};
}

function findCatalog(name: string): SlashCommand {
	const cmd = buildCatalogSlashCommands().find((c) => c.name === name);
	if (!cmd) throw new Error(`catalog command "${name}" not found`);
	return cmd;
}

beforeEach(() => {
	hasRoleAccess.mockReset();
	hasRoleAccess.mockResolvedValue(true);
});

describe("catalog → DiscordSlashCommand mapping", () => {
	it("maps every discord catalog command to a SlashCommand with an execute", () => {
		const catalog = getConnectorCommands("discord");
		const mapped = catalog.map(mapCatalogCommand);

		expect(mapped.length).toBe(catalog.length);
		for (let i = 0; i < mapped.length; i += 1) {
			expect(mapped[i].name).toBe(catalog[i].name);
			expect(mapped[i].description).toBe(catalog[i].description);
			expect(typeof mapped[i].execute).toBe("function");
		}
	});

	it("caps mapped option choices at Discord's 25 and keeps token shape", () => {
		// Navigation commands (the old /settings source of a choices-bearing
		// option) are app-surface-only now, so drive the mapper directly.
		const mapped = mapCatalogCommand({
			name: "pick",
			description: "Pick a token",
			target: { kind: "agent" },
			options: [
				{
					name: "section",
					description: "Token",
					required: false,
					choices: Array.from({ length: 30 }, (_, i) => `token-${i}`),
				},
			],
			requiresAuth: false,
			requiresElevated: false,
		});
		const section = mapped.options?.find((o) => o.name === "section");
		expect(section).toBeDefined();
		expect(section?.type).toBe("string");
		// Discord caps option choices at 25; mapping must respect that.
		expect(section?.choices?.length).toBe(25);
		for (const choice of section?.choices ?? []) {
			expect(choice.name.length).toBeLessThanOrEqual(100);
			expect(choice.value.length).toBeGreaterThan(0);
		}
	});

	it("omits options for argless commands", () => {
		const whoami = findCatalog("whoami");
		expect(whoami.options).toBeUndefined();
	});

	it("gates the native picker on catalog auth flags", () => {
		// elevated -> Administrator, auth -> ManageGuild, open -> ungated. Discord
		// still hides these in the guild picker; server-side trust re-checks.
		const elevated = mapCatalogCommand({
			name: "op",
			description: "op",
			target: { kind: "agent" },
			options: [],
			requiresAuth: true,
			requiresElevated: true,
		});
		expect(elevated.requiredPermissions).toBe(
			PermissionFlagsBits.Administrator,
		);
		const authed = mapCatalogCommand({
			name: "auth",
			description: "auth",
			target: { kind: "agent" },
			options: [],
			requiresAuth: true,
			requiresElevated: false,
		});
		expect(authed.requiredPermissions).toBe(PermissionFlagsBits.ManageGuild);
		const open = mapCatalogCommand({
			name: "open",
			description: "open",
			target: { kind: "agent" },
			options: [],
			requiresAuth: false,
			requiresElevated: false,
		});
		expect(open.requiredPermissions).toBeUndefined();
	});
});

describe("buildCatalogSlashCommands dedupe", () => {
	it("excludes names already present (built-ins win)", () => {
		const withoutDedupe = buildCatalogSlashCommands();
		const names = new Set(withoutDedupe.map((c) => c.name));
		expect(names.has("whoami")).toBe(true);
		// Navigation commands are app-surface-only and never reach Discord.
		expect(names.has("orchestrator")).toBe(false);
		expect(names.has("views")).toBe(false);

		const deduped = buildCatalogSlashCommands(new Set(["whoami", "help"]));
		const dedupedNames = deduped.map((c) => c.name);
		expect(dedupedNames).not.toContain("whoami");
		expect(dedupedNames).not.toContain("help");
		// Non-overlapping commands still come through.
		expect(dedupedNames).toContain("think");
	});

	it("never emits duplicate names", () => {
		const names = buildCatalogSlashCommands().map((c) => c.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("per-target execute branching", () => {
	it("navigate: replies ephemerally describing the destination (defensive)", async () => {
		// Navigation commands are filtered off connector surfaces upstream; the
		// branch stays as defensive handling, mirroring the client-target case.
		const orchestrator = mapCatalogCommand({
			name: "orchestrator",
			description: "Open the orchestrator",
			target: {
				kind: "navigate",
				path: "/orchestrator",
				viewId: "orchestrator",
			},
			options: [],
		});
		const interaction = makeInteraction();
		await orchestrator.execute(interaction as never, makeRuntime());

		expect(interaction.reply).toHaveBeenCalledTimes(1);
		const arg = interaction.reply.mock.calls[0][0] as {
			content: string;
			ephemeral: boolean;
		};
		expect(arg.ephemeral).toBe(true);
		expect(arg.content).toContain("orchestrator");
		expect(interaction.deferReply).not.toHaveBeenCalled();
	});

	it("navigate: resolves the /settings section alias to its canonical id (defensive)", async () => {
		const settings = mapCatalogCommand({
			name: "settings",
			description: "Open agent settings",
			target: { kind: "navigate", path: "/settings", tab: "settings" },
			options: [
				{
					name: "section",
					description: "Settings section to open",
					required: false,
					choices: [],
				},
			],
		});
		const interaction = makeInteraction({ section: "providers" });
		await settings.execute(interaction as never, makeRuntime());

		const arg = interaction.reply.mock.calls[0][0] as { content: string };
		// "providers" is an alias for the "ai-model" section.
		expect(arg.content).toContain("ai-model");
	});

	it("agent option command: resolves a deterministic local reply", async () => {
		const think = findCatalog("think");
		const interaction = makeInteraction({ level: "high" });
		const handleMessage = vi.fn(async () => undefined);
		const runtime = makeRuntime({
			messageService: { handleMessage } as never,
		});

		await think.execute(interaction as never, runtime);

		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(handleMessage).not.toHaveBeenCalled();
		expect(interaction.reply).toHaveBeenCalledTimes(1);
		const replyArg = interaction.reply.mock.calls[0][0] as {
			content: string;
			ephemeral: boolean;
		};
		expect(replyArg.ephemeral).toBe(true);
		expect(replyArg.content).toBe("Thinking set to high.");
	});

	it("agent (pipeline-owned): routes the command text through the message service and replies", async () => {
		// `stop` is an agent command with side effects owned by the pipeline, so
		// it must route through the agent.
		const stop = findCatalog("stop");
		const interaction = makeInteraction();

		const handleMessage = vi.fn(
			async (
				_runtime: IAgentRuntime,
				_message: Memory,
				callback: (content: Content) => Promise<Memory[]>,
			) => {
				await callback({ text: "Stopped.", source: "discord" });
			},
		);
		const runtime = makeRuntime({
			messageService: { handleMessage } as never,
		});

		await stop.execute(interaction as never, runtime);

		expect(interaction.deferReply).toHaveBeenCalledTimes(1);
		expect(handleMessage).toHaveBeenCalledTimes(1);
		const routedMessage = handleMessage.mock.calls[0][1] as Memory;
		expect(routedMessage.content.text).toBe("/stop");
		expect(routedMessage.content.source).toBe("discord");
		const editArg = interaction.editReply.mock.calls[0][0] as {
			content: string;
		};
		expect(editArg.content).toBe("Stopped.");
	});

	it("agent (pipeline-owned): falls back to a confirmation when the agent produces no text", async () => {
		const stop = findCatalog("stop");
		const interaction = makeInteraction();
		const handleMessage = vi.fn(async () => undefined);
		const runtime = makeRuntime({
			messageService: { handleMessage } as never,
		});

		await stop.execute(interaction as never, runtime);

		const editArg = interaction.editReply.mock.calls[0][0] as {
			content: string;
		};
		expect(editArg.content).toContain("/stop");
	});
});

describe("auth gating", () => {
	it("refuses a requiresAuth command when the sender is not an owner", async () => {
		// `restart` requires auth and is pipeline-owned. Deny both roles.
		hasRoleAccess.mockResolvedValue(false);
		const restart = findCatalog("restart");
		const interaction = makeInteraction();
		const handleMessage = vi.fn(async () => undefined);
		const runtime = makeRuntime({
			messageService: { handleMessage } as never,
		});

		await restart.execute(interaction as never, runtime);

		// Refused before any dispatch: no pipeline call, no defer — just a reply.
		expect(handleMessage).not.toHaveBeenCalled();
		expect(interaction.deferReply).not.toHaveBeenCalled();
		expect(interaction.reply).toHaveBeenCalledTimes(1);
		const arg = interaction.reply.mock.calls[0][0] as {
			content: string;
			ephemeral: boolean;
		};
		expect(arg.ephemeral).toBe(true);
		expect(arg.content).toContain("requires authorization");
	});

	it("allows a requiresAuth command when the sender is an owner", async () => {
		// OWNER access satisfies requiresAuth; the command then routes to the agent.
		hasRoleAccess.mockResolvedValue(true);
		const restart = findCatalog("restart");
		const interaction = makeInteraction();
		const handleMessage = vi.fn(
			async (
				_runtime: IAgentRuntime,
				_message: Memory,
				callback: (content: Content) => Promise<Memory[]>,
			) => {
				await callback({ text: "Restarting.", source: "discord" });
			},
		);
		const runtime = makeRuntime({
			messageService: { handleMessage } as never,
		});

		await restart.execute(interaction as never, runtime);

		expect(handleMessage).toHaveBeenCalledTimes(1);
		const editArg = interaction.editReply.mock.calls[0][0] as {
			content: string;
		};
		expect(editArg.content).toBe("Restarting.");
	});

	it("resolves owner via the OWNER role and elevation via the ADMIN role", async () => {
		// `restart` only needs the OWNER check to pass; assert the entity-scoped
		// role resolution is consulted with the required role.
		hasRoleAccess.mockResolvedValue(true);
		const restart = findCatalog("restart");
		const interaction = makeInteraction();
		const runtime = makeRuntime({
			messageService: { handleMessage: vi.fn(async () => undefined) } as never,
		});

		await restart.execute(interaction as never, runtime);

		const requestedRoles = hasRoleAccess.mock.calls.map((call) => call[2]);
		expect(requestedRoles).toContain("OWNER");
		expect(requestedRoles).toContain("ADMIN");
	});
});

describe("Discord embedded app launch command", () => {
	it("normalizes a configured HTTPS app URL to /embed?platform=discord", () => {
		expect(
			resolveDiscordEmbedUrl(
				makeRuntime({
					getSetting: vi.fn((key: string) =>
						key === "ELIZA_EMBED_URL"
							? "https://app.elizacloud.ai/"
							: undefined,
					),
				}),
			),
		).toBe("https://app.elizacloud.ai/embed?platform=discord");
		expect(
			resolveDiscordEmbedUrl(
				makeRuntime({
					getSetting: vi.fn((key: string) =>
						key === "ELIZA_EMBED_URL"
							? "http://app.elizacloud.ai/embed"
							: undefined,
					),
				}),
			),
		).toBeNull();
	});

	it("replies with an embed launch link only for OWNER or ADMIN senders", async () => {
		const command = buildDiscordEmbedCommand();

		hasRoleAccess.mockResolvedValue(false);
		const denied = makeInteraction();
		await command.execute(
			denied as never,
			makeRuntime({
				getSetting: vi.fn(() => "https://app.elizacloud.ai/embed"),
			}),
		);
		expect(denied.reply.mock.calls[0]?.[0]).toMatchObject({
			content: expect.stringContaining("OWNER or ADMIN"),
			ephemeral: true,
		});

		hasRoleAccess.mockReset();
		hasRoleAccess.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const allowed = makeInteraction();
		await command.execute(
			allowed as never,
			makeRuntime({
				getSetting: vi.fn(() => "https://app.elizacloud.ai/embed"),
			}),
		);
		expect(allowed.reply.mock.calls[0]?.[0]).toMatchObject({
			content:
				"Open the Eliza app: https://app.elizacloud.ai/embed?platform=discord",
			ephemeral: true,
		});
	});
});

describe("registerCatalogSlashCommands", () => {
	let added: string[] = [];

	beforeEach(() => {
		added = [];
	});

	function cleanup() {
		for (const name of added) removeCommand(name);
	}

	it("adds catalog commands to the in-process registry, skipping built-ins", () => {
		const before = new Set(getRegisteredCommands().keys());
		expect(before.has("help")).toBe(true); // built-in present

		const registered = registerCatalogSlashCommands(makeRuntime());
		added = registered.map((c) => c.name);

		try {
			const names = registered.map((c) => c.name);
			// Built-in names are not re-registered by the catalog pass.
			expect(names).not.toContain("help");
			expect(names).not.toContain("status");
			expect(names).not.toContain("settings");
			// New catalog commands are added.
			if (before.has("app")) {
				expect(names).not.toContain("app");
			} else {
				expect(names).toContain("app");
			}
			// Navigation commands are app-surface-only and never reach Discord.
			expect(names).not.toContain("orchestrator");
			expect(names).toContain("think");

			const registry = getRegisteredCommands();
			expect(registry.get("app")).toMatchObject({
				name: "app",
				execute: expect.any(Function),
			});
			for (const name of names) {
				expect(registry.has(name)).toBe(true);
			}
			// Built-in handlers remain untouched.
			expect(registry.get("help")).toBeDefined();
		} finally {
			cleanup();
		}
	});
});

/**
 * Full native-picker simulation sweep (#16172 follow-through): every catalog
 * command on the discord surface is executed through a synthetic
 * ChatInputCommandInteraction — the same execute path a real picker invocation
 * takes (sender auth -> connector gate -> deterministic resolve or pipeline
 * dispatch) — and must reply without throwing. Deterministic commands hit a
 * canned loopback router instead of the live API; pipeline commands hit a
 * mocked messageService. This is the owner-side "fire every command" check
 * that cannot be driven from outside Discord (bots cannot invoke application
 * commands), productized so rot in ANY command is caught in CI.
 */
describe("native interaction sweep — full catalog surface", () => {
	/** Canned loopback API for the deterministic command handlers. */
	function stubLoopbackFetch(): ReturnType<typeof vi.fn> {
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/models/config")) {
				return json({ targets: { small: {}, large: {}, coding: {} } });
			}
			if (url.includes("/api/models")) {
				return json({ providers: {}, catalog: { providers: {} } });
			}
			if (url.includes("/api/accounts")) {
				return json({ providers: [] });
			}
			if (url.includes("/api/runtime/model-switch")) {
				return json({ ok: true, target: "cloud", model: "m", status: "ready" });
			}
			return json({ ok: true });
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	function makePipelineRuntime() {
		const handleMessage = vi.fn(
			async (
				_runtime: IAgentRuntime,
				_message: Memory,
				callback: (content: Content) => Promise<Memory[]>,
			) => {
				await callback({ text: "pipeline reply" } as Content);
				return { handled: true };
			},
		);
		return makeRuntime({
			messageService: { handleMessage } as never,
		});
	}

	function repliedOnce(interaction: MockInteraction): boolean {
		return (
			interaction.reply.mock.calls.length > 0 ||
			interaction.editReply.mock.calls.length > 0
		);
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const surface = getConnectorCommands("discord");

	for (const command of surface) {
		it(`/${command.name} (owner, bare) replies without throwing`, async () => {
			hasRoleAccess.mockResolvedValue(true);
			stubLoopbackFetch();
			const interaction = makeInteraction();
			const mapped = mapCatalogCommand(command);
			await mapped.execute(interaction as never, makePipelineRuntime());
			expect(repliedOnce(interaction)).toBe(true);
		});
	}

	for (const command of surface.filter((c) => c.requiresAuth)) {
		it(`/${command.name} (guest) refuses and never reaches a backend`, async () => {
			hasRoleAccess.mockResolvedValue(false);
			const fetchMock = stubLoopbackFetch();
			const interaction = makeInteraction();
			const runtime = makePipelineRuntime();
			const mapped = mapCatalogCommand(command);
			await mapped.execute(interaction as never, runtime);
			expect(interaction.reply).toHaveBeenCalledTimes(1);
			const arg = interaction.reply.mock.calls[0][0] as {
				content: string;
				ephemeral: boolean;
			};
			expect(arg.ephemeral).toBe(true);
			expect(arg.content).toMatch(/authorization|elevated/);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(
				(runtime.messageService as { handleMessage: ReturnType<typeof vi.fn> })
					.handleMessage,
			).not.toHaveBeenCalled();
		});
	}
});
