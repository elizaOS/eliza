import type { Content, IAgentRuntime, Memory } from "@elizaos/core";
import { getConnectorCommands } from "@elizaos/plugin-commands";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCatalogSlashCommands,
	mapCatalogCommand,
	registerCatalogSlashCommands,
} from "../catalog-commands";
import {
	getRegisteredCommands,
	removeCommand,
	type SlashCommand,
} from "../slash-commands";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

function makeRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		messageService: null,
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
	user: { id: string };
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
		user: { id: "123456789012345678" },
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

	it("maps option choices for the /settings section option", () => {
		const catalogSettings = getConnectorCommands("discord").find(
			(c) => c.name === "settings",
		);
		expect(catalogSettings).toBeDefined();

		const mapped = mapCatalogCommand(
			catalogSettings as NonNullable<typeof catalogSettings>,
		);
		const section = mapped.options?.find((o) => o.name === "section");
		expect(section).toBeDefined();
		expect(section?.type).toBe("string");
		// Discord caps option choices at 25; mapping must respect that.
		expect(section?.choices?.length).toBeGreaterThan(0);
		expect(section?.choices?.length).toBeLessThanOrEqual(25);
		// Choice name + value should be the catalog token.
		for (const choice of section?.choices ?? []) {
			expect(choice.name.length).toBeLessThanOrEqual(100);
			expect(choice.value.length).toBeGreaterThan(0);
		}
	});

	it("omits options for argless commands", () => {
		const orchestrator = findCatalog("orchestrator");
		expect(orchestrator.options).toBeUndefined();
	});
});

describe("buildCatalogSlashCommands dedupe", () => {
	it("excludes names already present (built-ins win)", () => {
		const withoutDedupe = buildCatalogSlashCommands();
		const names = new Set(withoutDedupe.map((c) => c.name));
		expect(names.has("settings")).toBe(true);

		const deduped = buildCatalogSlashCommands(new Set(["settings", "help"]));
		const dedupedNames = deduped.map((c) => c.name);
		expect(dedupedNames).not.toContain("settings");
		expect(dedupedNames).not.toContain("help");
		// Non-overlapping commands still come through.
		expect(dedupedNames).toContain("orchestrator");
	});

	it("never emits duplicate names", () => {
		const names = buildCatalogSlashCommands().map((c) => c.name);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("per-target execute branching", () => {
	it("navigate: replies ephemerally describing the destination", async () => {
		const orchestrator = findCatalog("orchestrator");
		const interaction = makeInteraction();
		await orchestrator.execute(interaction as never, makeRuntime());

		expect(interaction.reply).toHaveBeenCalledTimes(1);
		const arg = interaction.reply.mock.calls[0][0] as {
			content: string;
			ephemeral: boolean;
		};
		expect(arg.ephemeral).toBe(true);
		expect(arg.content).toContain("orchestrator");
		expect(arg.content).toContain("/orchestrator");
		expect(interaction.deferReply).not.toHaveBeenCalled();
	});

	it("navigate: resolves the /settings section alias to its canonical id", async () => {
		const settings = findCatalog("settings");
		const interaction = makeInteraction({ section: "providers" });
		await settings.execute(interaction as never, makeRuntime());

		const arg = interaction.reply.mock.calls[0][0] as { content: string };
		// "providers" is an alias for the "ai-model" section.
		expect(arg.content).toContain("ai-model");
	});

	it("agent: routes the command text through the message service and replies", async () => {
		const think = findCatalog("think");
		const interaction = makeInteraction({ level: "high" });

		const handleMessage = vi.fn(
			async (
				_runtime: IAgentRuntime,
				_message: Memory,
				callback: (content: Content) => Promise<Memory[]>,
			) => {
				await callback({
					text: "Thinking level set to high.",
					source: "discord",
				});
			},
		);
		const runtime = makeRuntime({
			messageService: { handleMessage } as never,
		});

		await think.execute(interaction as never, runtime);

		expect(interaction.deferReply).toHaveBeenCalledTimes(1);
		expect(handleMessage).toHaveBeenCalledTimes(1);
		// The reconstructed command text is fed to the agent.
		const routedMessage = handleMessage.mock.calls[0][1] as Memory;
		expect(routedMessage.content.text).toBe("/think high");
		expect(routedMessage.content.source).toBe("discord");
		// The captured agent reply is surfaced via editReply.
		const editArg = interaction.editReply.mock.calls[0][0] as {
			content: string;
		};
		expect(editArg.content).toBe("Thinking level set to high.");
	});

	it("agent: falls back to a confirmation when the agent produces no text", async () => {
		const status = findCatalog("status");
		const interaction = makeInteraction();
		const handleMessage = vi.fn(async () => undefined);
		const runtime = makeRuntime({
			messageService: { handleMessage } as never,
		});

		await status.execute(interaction as never, runtime);

		const editArg = interaction.editReply.mock.calls[0][0] as {
			content: string;
		};
		expect(editArg.content).toContain("/status");
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
			expect(names).toContain("orchestrator");
			expect(names).toContain("think");

			const registry = getRegisteredCommands();
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
