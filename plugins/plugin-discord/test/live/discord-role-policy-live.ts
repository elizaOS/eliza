import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type AgentRuntime,
	asUUID,
	ChannelType,
	createUniqueUuid,
	type Entity,
	type IAgentRuntime,
	type Memory,
	type Room,
	setConnectorAdminWhitelist,
	type World,
} from "@elizaos/core";
import {
	PTYService,
	sendToAgentAction,
	startCodingTaskAction,
} from "@elizaos/plugin-agent-orchestrator";
import { createTestRuntime } from "../helpers/pglite-runtime.ts";

type DiscordConfig = {
	env?: {
		DISCORD_API_TOKEN?: string;
	};
	plugins?: {
		entries?: {
			discord?: {
				config?: {
					DISCORD_API_TOKEN?: string;
				};
			};
		};
	};
};

type DiscordGuild = {
	id: string;
	name: string;
	owner?: boolean;
};

type DiscordGuildDetail = {
	id: string;
	name: string;
	owner_id: string;
};

type DiscordMember = {
	user?: {
		id: string;
		username: string;
		bot?: boolean;
	};
	roles?: string[];
};

const KEEP_ARTIFACTS = process.env.ELIZA_KEEP_LIVE_ARTIFACTS === "1";

async function waitFor(
	predicate: () => Promise<boolean>,
	message: string,
	timeoutMs = 120_000,
	intervalMs = 1_000,
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(message);
}

function loadDiscordToken(): string {
	const configPath = path.join(os.homedir(), ".eliza", "eliza.json");
	const parsed = JSON.parse(
		fs.readFileSync(configPath, "utf8"),
	) as DiscordConfig;
	const fromConfig =
		parsed.env?.DISCORD_API_TOKEN?.trim() ??
		parsed.plugins?.entries?.discord?.config?.DISCORD_API_TOKEN?.trim();
	if (fromConfig) {
		return fromConfig;
	}

	const fromEnv = process.env.DISCORD_BOT_TOKEN?.trim();
	if (!fromEnv) {
		throw new Error(
			"DISCORD_BOT_TOKEN is not configured in the environment or ~/.eliza/eliza.json",
		);
	}
	return fromEnv;
}

async function discordRequest<T>(token: string, pathname: string): Promise<T> {
	const response = await fetch(`https://discord.com/api/v10${pathname}`, {
		headers: {
			Authorization: `Bot ${token}`,
		},
	});
	if (!response.ok) {
		throw new Error(
			`Discord API ${pathname} failed: ${response.status} ${response.statusText}`,
		);
	}
	return (await response.json()) as T;
}

function buildDiscordMessage(
	runtime: IAgentRuntime,
	room: Room,
	entity: Entity,
	text: string,
	discordUserId: string,
	username: string,
): Memory {
	return {
		id: createUniqueUuid(runtime, `${entity.id}-${Date.now()}`),
		agentId: runtime.agentId,
		entityId: entity.id,
		roomId: room.id,
		userId: discordUserId,
		content: {
			text,
			source: "discord",
			metadata: {
				bridgeSender: {
					metadata: {
						discord: {
							userId: discordUserId,
							id: discordUserId,
							username,
						},
					},
				},
			},
		},
		createdAt: Date.now(),
	} as Memory;
}

let runtime: AgentRuntime | undefined;
let cleanupRuntime: (() => Promise<void>) | undefined;
let service: PTYService | undefined;
const sessionsToStop = new Set<string>();
let workdir: string | undefined;

async function cleanup(): Promise<void> {
	if (service) {
		for (const sessionId of sessionsToStop) {
			try {
				await service.stopSession(sessionId, true);
			} catch {}
		}
	}
	try {
		await service?.stop();
	} catch {}
	try {
		await cleanupRuntime?.();
	} catch {}
	if (workdir) {
		if (KEEP_ARTIFACTS) {
			console.log(
				"[discord-role-policy-live] preserving artifacts",
				JSON.stringify({ workdir }),
			);
		} else {
			fs.rmSync(workdir, { recursive: true, force: true });
		}
	}
}

async function main(): Promise<void> {
	const token = loadDiscordToken();
	const guilds = await discordRequest<DiscordGuild[]>(
		token,
		"/users/@me/guilds",
	);
	const cozyGuild = guilds.find((guild) => guild.name === "Cozy Devs");
	assert.ok(cozyGuild, "Expected the bot to be installed in Cozy Devs");

	const cozyGuildDetail = await discordRequest<DiscordGuildDetail>(
		token,
		`/guilds/${cozyGuild.id}`,
	);
	assert.ok(
		cozyGuildDetail.owner_id,
		"Expected Cozy Devs guild detail to include an owner_id",
	);

	const members = await discordRequest<DiscordMember[]>(
		token,
		`/guilds/${cozyGuild.id}/members?limit=200`,
	);
	assert.ok(
		members.length > 0,
		"Expected Cozy Devs to expose guild members for live role verification",
	);

	let deniedUserId = "";
	let deniedUsername = "";
	for (const member of members) {
		const discordUser = member.user;
		if (!discordUser || discordUser.bot) {
			continue;
		}
		if (discordUser.id === cozyGuildDetail.owner_id) {
			continue;
		}
		deniedUserId = discordUser.id;
		deniedUsername = discordUser.username;
		break;
	}
	assert.ok(
		deniedUserId,
		"Expected to find at least one non-owner human member in Cozy Devs",
	);

	({ runtime, cleanup: cleanupRuntime } = await createTestRuntime());
	service = await PTYService.start(runtime as IAgentRuntime);
	(runtime.services as Map<string, unknown[]>).set("PTY_SERVICE", [
		service as unknown,
	]);

	const originalGetSetting = runtime.getSetting.bind(runtime);
	runtime.getSetting = ((key: string) => {
		if (key === "TASK_AGENT_ROLE_POLICY") {
			return JSON.stringify({
				default: "GUEST",
				connectors: {
					discord: {
						create: "ADMIN",
						interact: "ADMIN",
					},
				},
			});
		}
		return originalGetSetting(key);
	}) as IAgentRuntime["getSetting"];

	setConnectorAdminWhitelist(runtime as IAgentRuntime, {
		discord: [cozyGuildDetail.owner_id],
	});

	const allowedEntity: Entity = {
		id: asUUID(randomUUID()),
		names: ["Cozy Devs Owner"],
		agentId: runtime.agentId,
		metadata: {
			discord: {
				userId: cozyGuildDetail.owner_id,
				id: cozyGuildDetail.owner_id,
				username: "cozy-owner",
			},
		},
	};
	const deniedEntity: Entity = {
		id: asUUID(randomUUID()),
		names: [deniedUsername],
		agentId: runtime.agentId,
		metadata: {
			discord: {
				userId: deniedUserId,
				id: deniedUserId,
				username: deniedUsername,
			},
		},
	};
	await runtime.createEntity(allowedEntity);
	await runtime.createEntity(deniedEntity);

	const world: World = {
		id: asUUID(randomUUID()),
		agentId: runtime.agentId,
		name: "Cozy Devs live role world",
		messageServerId: cozyGuild.id,
		metadata: {
			ownership: {
				ownerId: allowedEntity.id,
			},
		},
	};
	await runtime.ensureWorldExists(world);

	const room: Room = {
		id: asUUID(randomUUID()),
		name: "Cozy Devs bot-commands mirror",
		type: ChannelType.GROUP,
		source: "discord",
		worldId: world.id,
		serverId: cozyGuild.id,
	};
	await runtime.createRoom(room);
	await runtime.ensureParticipantInRoom(runtime.agentId, room.id);
	await runtime.ensureParticipantInRoom(allowedEntity.id, room.id);
	await runtime.ensureParticipantInRoom(deniedEntity.id, room.id);

	workdir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-discord-role-live-"));
	const firstFile = path.join(workdir, "discord-owner-proof.txt");
	const secondFile = path.join(workdir, "discord-owner-followup.txt");
	const firstSentinel = `DISCORD_OWNER_CREATE_${Date.now()}`;
	const secondSentinel = `DISCORD_OWNER_INTERACT_${Date.now()}`;

	const allowedCreateMessage = buildDiscordMessage(
		runtime as IAgentRuntime,
		room,
		allowedEntity,
		"Create a task agent in Discord and prove it worked.",
		cozyGuildDetail.owner_id,
		"cozy-owner",
	);
	const deniedCreateMessage = buildDiscordMessage(
		runtime as IAgentRuntime,
		room,
		deniedEntity,
		"Try to create a task agent without the required role.",
		deniedUserId,
		deniedUsername,
	);

	const allowedCreate = await startCodingTaskAction.handler(
		runtime as IAgentRuntime,
		allowedCreateMessage,
		undefined,
		{
			parameters: {
				agentType: "shell",
				label: "discord-live-authorized",
				task:
					`printf '%s\\n' ${JSON.stringify(firstSentinel)} > ${JSON.stringify(firstFile)}; ` +
					`echo ${JSON.stringify(firstSentinel)}`,
			},
		},
	);
	assert.equal(
		allowedCreate?.success,
		true,
		"Expected whitelisted Discord owner to create a task agent",
	);
	const allowedSessionId =
		Array.isArray(allowedCreate?.data?.agents) &&
		allowedCreate?.data?.agents[0] &&
		typeof allowedCreate.data.agents[0].sessionId === "string"
			? allowedCreate.data.agents[0].sessionId
			: "";
	assert.ok(
		allowedSessionId,
		"Expected allowed Discord create path to return a session",
	);
	sessionsToStop.add(allowedSessionId);

	const deniedCreate = await startCodingTaskAction.handler(
		runtime as IAgentRuntime,
		deniedCreateMessage,
		undefined,
		{
			parameters: {
				agentType: "shell",
				task: "echo should-not-run",
			},
		},
	);
	assert.equal(
		deniedCreate?.success,
		false,
		"Expected non-whitelisted Discord user to be denied task creation",
	);
	assert.equal(deniedCreate?.error, "FORBIDDEN");

	await waitFor(
		async () =>
			fs.existsSync(firstFile) &&
			fs.readFileSync(firstFile, "utf8").trim() === firstSentinel,
		"Expected authorized Discord create flow to run the shell task",
	);

	const deniedInteract = await sendToAgentAction.handler(
		runtime as IAgentRuntime,
		deniedCreateMessage,
		undefined,
		{
			parameters: {
				sessionId: allowedSessionId,
				input: "echo denied",
			},
		},
	);
	assert.equal(
		deniedInteract?.success,
		false,
		"Expected non-whitelisted Discord user to be denied interaction",
	);
	assert.equal(deniedInteract?.error, "FORBIDDEN");

	const allowedInteract = await sendToAgentAction.handler(
		runtime as IAgentRuntime,
		allowedCreateMessage,
		undefined,
		{
			parameters: {
				sessionId: allowedSessionId,
				task:
					`printf '%s\\n' ${JSON.stringify(secondSentinel)} > ${JSON.stringify(secondFile)}; ` +
					`echo ${JSON.stringify(secondSentinel)}`,
			},
		},
	);
	assert.equal(
		allowedInteract?.success,
		true,
		"Expected whitelisted Discord owner to interact with the running task agent",
	);

	await waitFor(
		async () =>
			fs.existsSync(secondFile) &&
			fs.readFileSync(secondFile, "utf8").trim() === secondSentinel,
		"Expected authorized Discord interact flow to run the follow-up shell task",
	);

	const coordinator = service.coordinator;
	assert.ok(coordinator, "Expected PTY service to expose a coordinator");
	const threads = await coordinator.listTaskThreads({ includeArchived: true });
	assert.equal(
		threads.length,
		1,
		"Expected only the authorized Discord request to create a persisted task thread",
	);

	console.log(
		"[discord-role-policy-live] PASS",
		JSON.stringify({
			guildId: cozyGuild.id,
			allowedDiscordUserId: cozyGuildDetail.owner_id,
			deniedDiscordUserId: deniedUserId,
			sessionId: allowedSessionId,
			workdir,
			firstFile,
			secondFile,
		}),
	);
}

try {
	await main();
	await cleanup();
	process.exit(0);
} catch (error) {
	console.error("[discord-role-policy-live] FAIL");
	console.error(error);
	await cleanup();
	process.exit(1);
}
