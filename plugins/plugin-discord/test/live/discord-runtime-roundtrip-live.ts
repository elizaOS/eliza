import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	createConversation,
	postConversationMessage,
} from "../helpers/http.ts";

type DiscordConfig = {
	token?: string;
	botToken?: string;
	applicationId?: string;
	enabled?: boolean;
};

type ElizaConfig = {
	logging?: {
		level?: string;
	};
	cloud?: {
		apiKey?: string;
	};
	serviceRouting?: Record<string, unknown>;
	linkedAccounts?: Record<string, unknown>;
	models?: Record<string, unknown>;
	agents?: Record<string, unknown>;
	connectors?: {
		discord?: DiscordConfig;
	};
	env?: {
		DISCORD_API_TOKEN?: string;
		DISCORD_APPLICATION_ID?: string;
	};
	plugins?: {
		allow?: string[];
		installs?: Record<
			string,
			{
				installPath?: string;
				version?: string;
			}
		>;
		entries?: {
			discord?: {
				enabled?: boolean;
				config?: {
					DISCORD_API_TOKEN?: string;
					DISCORD_APPLICATION_ID?: string;
				};
			};
		};
	};
};

type DiscordGuild = {
	id: string;
	name: string;
};

type DiscordChannel = {
	id: string;
	name: string;
	type: number;
};

type DiscordMessage = {
	id: string;
	content: string;
	timestamp: string;
	author: {
		id: string;
		username: string;
		bot?: boolean;
	};
};

type HealthResponse = {
	ready?: boolean;
	runtime?: string;
	connectors?: Record<string, string>;
	plugins?: {
		loaded?: number;
		failed?: number;
	};
};

type StartedRuntime = {
	apiPort: number;
	stateDir: string;
	configPath: string;
	tempRoot: string;
	logPath: string;
	getLogTail: () => string;
	close: () => Promise<void>;
};

const REPO_ROOT = process.cwd();
const QA_ROOT = path.join(REPO_ROOT, ".tmp", "qa");
await mkdir(QA_ROOT, { recursive: true });
const REPORT_DIR = await mkdtemp(
	path.join(QA_ROOT, "discord-runtime-roundtrip-"),
);
const KEEP_ARTIFACTS = process.env.ELIZA_KEEP_LIVE_ARTIFACTS === "1";
const GUILD_NAME = process.env.DISCORD_QA_GUILD_NAME ?? "Cozy Devs";
const GUILD_ID = process.env.DISCORD_QA_GUILD_ID ?? "1051457140637827122";
const CHANNEL_ID = process.env.DISCORD_QA_CHANNEL_ID ?? "1472326219759620258";
const TIMEOUT_MS = Math.max(
	60_000,
	Number.parseInt(process.env.DISCORD_QA_TIMEOUT_MS ?? "", 10) || 10 * 60_000,
);

function loadBaseConfig(): ElizaConfig {
	const configPath = path.join(os.homedir(), ".eliza", "eliza.json");
	return JSON.parse(fs.readFileSync(configPath, "utf8")) as ElizaConfig;
}

function resolveDiscordToken(config: ElizaConfig): string {
	const fromConfig =
		config.connectors?.discord?.token?.trim() ||
		config.connectors?.discord?.botToken?.trim() ||
		config.env?.DISCORD_API_TOKEN?.trim() ||
		config.plugins?.entries?.discord?.config?.DISCORD_API_TOKEN?.trim() ||
		"";
	if (fromConfig) {
		return fromConfig;
	}

	return process.env.DISCORD_BOT_TOKEN?.trim() || "";
}

function resolveDiscordApplicationId(config: ElizaConfig): string {
	return (
		config.connectors?.discord?.applicationId?.trim() ||
		config.env?.DISCORD_APPLICATION_ID?.trim() ||
		config.plugins?.entries?.discord?.config?.DISCORD_APPLICATION_ID?.trim() ||
		""
	);
}

function resolveCloudApiKey(config: ElizaConfig): string {
	return (
		process.env.ELIZAOS_CLOUD_API_KEY?.trim() ||
		process.env.ELIZA_CLOUD_API_KEY?.trim() ||
		config.cloud?.apiKey?.trim() ||
		""
	);
}

function buildRuntimeConfig(
	baseConfig: ElizaConfig,
	discordToken: string,
	discordApplicationId: string,
): ElizaConfig {
	const allow = new Set(baseConfig.plugins?.allow ?? []);
	allow.add("@elizaos/plugin-discord");
	allow.add("@elizaos/plugin-elizacloud");

	return {
		logging: {
			level:
				process.env.ELIZA_QA_LOG_LEVEL?.trim() ||
				baseConfig.logging?.level ||
				"info",
		},
		cloud: baseConfig.cloud,
		serviceRouting: baseConfig.serviceRouting,
		linkedAccounts: baseConfig.linkedAccounts,
		models: baseConfig.models,
		agents: baseConfig.agents,
		plugins: {
			...(baseConfig.plugins ?? {}),
			allow: Array.from(allow),
			installs: baseConfig.plugins?.installs,
			entries: {
				...(baseConfig.plugins?.entries ?? {}),
				discord: {
					...(baseConfig.plugins?.entries?.discord ?? {}),
					enabled: true,
					config: {
						...(baseConfig.plugins?.entries?.discord?.config ?? {}),
						DISCORD_API_TOKEN: discordToken,
						DISCORD_APPLICATION_ID: discordApplicationId,
					},
				},
			},
		},
		connectors: {
			...(baseConfig.connectors ?? {}),
			discord: {
				enabled: true,
				token: discordToken,
				applicationId: discordApplicationId,
			},
		},
	};
}

async function getFreePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a loopback port"));
				return;
			}

			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

async function waitForChildExit(
	child: ChildProcessWithoutNullStreams,
	timeoutMs: number,
): Promise<boolean> {
	if (child.exitCode !== null) {
		return true;
	}

	return await new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

async function discordRequest<T>(
	token: string,
	pathname: string,
	init: RequestInit = {},
): Promise<T> {
	const response = await fetch(`https://discord.com/api/v10${pathname}`, {
		...init,
		headers: {
			Authorization: `Bot ${token}`,
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Discord API ${pathname} failed: ${response.status} ${response.statusText}\n${body}`,
		);
	}
	if (response.status === 204) {
		return undefined as T;
	}
	return (await response.json()) as T;
}

async function waitForJsonPredicate<T>(
	url: string,
	predicate: (value: T) => boolean,
	timeoutMs: number,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastBody = "";
	let lastError = "";

	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			lastBody = await response.text();
			if (!response.ok) {
				lastError = `${response.status} ${response.statusText}`;
			} else {
				const parsed = JSON.parse(lastBody) as T;
				if (predicate(parsed)) {
					return parsed;
				}
			}
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await sleep(1_500);
	}

	throw new Error(
		`Timed out waiting for ${url}\nlastError=${lastError}\nlastBody=${lastBody}`,
	);
}

async function startRuntime(
	config: ElizaConfig,
	discordToken: string,
	discordApplicationId: string,
	cloudApiKey: string,
): Promise<StartedRuntime> {
	const tempRoot = await mkdtemp(
		path.join(os.tmpdir(), "eliza-discord-runtime-"),
	);
	const stateDir = path.join(tempRoot, "state");
	const configPath = path.join(tempRoot, "eliza.json");
	const logPath = path.join(tempRoot, "runtime.log");
	const apiPort = await getFreePort();
	const logs: string[] = [];

	await mkdir(stateDir, { recursive: true });
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

	const child = spawn("bun", ["run", "start:eliza"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			CI: "1",
			ELIZA_DISABLE_WORKSPACE_PLUGIN_OVERRIDES: "1",
			ELIZA_SKIP_LOCAL_UPSTREAMS: "1",
			ELIZA_CONFIG_PATH: configPath,
			ELIZA_STATE_DIR: stateDir,
			ELIZA_PORT: String(apiPort),
			ELIZA_API_PORT: String(apiPort),
			ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
			DISCORD_API_TOKEN: discordToken,
			DISCORD_BOT_TOKEN: discordToken,
			DISCORD_APPLICATION_ID: discordApplicationId,
			CHANNEL_IDS: CHANNEL_ID,
			DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS: "false",
			ELIZAOS_CLOUD_API_KEY: cloudApiKey,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");

	const appendLog = (chunk: string) => {
		logs.push(chunk);
		fs.appendFileSync(logPath, chunk, "utf8");
	};

	child.stdout.on("data", (chunk: string) => appendLog(chunk));
	child.stderr.on("data", (chunk: string) => appendLog(chunk));

	try {
		await waitForJsonPredicate<HealthResponse>(
			`http://127.0.0.1:${apiPort}/api/health`,
			(value) =>
				value.ready === true &&
				value.runtime === "ok" &&
				typeof value.connectors?.discord === "string",
			120_000,
		);
	} catch (error) {
		const logTail = logs.join("").slice(-12_000);
		if (child.exitCode == null) {
			child.kill("SIGKILL");
			await waitForChildExit(child, 5_000);
		}
		if (!KEEP_ARTIFACTS) {
			await rm(tempRoot, { recursive: true, force: true });
		}
		throw new Error(
			`Discord live runtime failed to start: ${error instanceof Error ? error.message : String(error)}\n${logTail}`,
		);
	}

	return {
		apiPort,
		stateDir,
		configPath,
		tempRoot,
		logPath,
		getLogTail: () => logs.join("").slice(-12_000),
		close: async () => {
			if (child.exitCode == null) {
				child.kill("SIGTERM");
				const exited = await waitForChildExit(child, 10_000);
				if (!exited && child.exitCode == null) {
					child.kill("SIGKILL");
					await waitForChildExit(child, 5_000);
				}
			}

			if (!KEEP_ARTIFACTS) {
				await rm(tempRoot, { recursive: true, force: true });
			}
		},
	};
}

async function verifyLocalChat(runtime: StartedRuntime): Promise<{
	conversationId: string;
	responseText: string;
}> {
	const { conversationId } = await createConversation(runtime.apiPort, {
		title: "Discord runtime live QA",
	});
	const response = await postConversationMessage(
		runtime.apiPort,
		conversationId,
		{
			text: "Reply with the exact token LOCAL_RUNTIME_OK and nothing else.",
		},
	);
	if (response.status !== 200) {
		throw new Error(
			`Local chat smoke failed with status ${response.status}\n${JSON.stringify(response.data, null, 2)}\n${runtime.getLogTail()}`,
		);
	}
	const responseText = String(response.data.text ?? "");
	if (!responseText.includes("LOCAL_RUNTIME_OK")) {
		throw new Error(
			`Local chat smoke did not return the expected token.\nresponse=${responseText}\n${runtime.getLogTail()}`,
		);
	}
	return { conversationId, responseText };
}

async function main(): Promise<void> {
	const baseConfig = loadBaseConfig();
	const discordToken = resolveDiscordToken(baseConfig);
	const discordApplicationId = resolveDiscordApplicationId(baseConfig);
	const cloudApiKey = resolveCloudApiKey(baseConfig);
	if (!discordToken) {
		throw new Error(
			"No Discord bot token found in environment or ~/.eliza/eliza.json",
		);
	}
	if (!cloudApiKey) {
		throw new Error(
			"No Eliza Cloud API key found in environment or ~/.eliza/eliza.json",
		);
	}

	const runtimeConfig = buildRuntimeConfig(
		baseConfig,
		discordToken,
		discordApplicationId,
	);
	const report: Record<string, unknown> = {
		generatedAt: new Date().toISOString(),
		reportDir: REPORT_DIR,
		guild: null,
		channel: null,
		botUser: null,
		runtime: null,
		health: null,
		localChat: null,
		postedChallenge: null,
		humanReply: null,
		botReply: null,
		status: "starting",
	};

	const runtime = await startRuntime(
		runtimeConfig,
		discordToken,
		discordApplicationId,
		cloudApiKey,
	);
	console.log(
		"[discord-runtime-roundtrip-live] runtime_started",
		JSON.stringify({
			reportDir: REPORT_DIR,
			apiPort: runtime.apiPort,
			configPath: runtime.configPath,
			logPath: runtime.logPath,
		}),
	);

	try {
		console.log("[discord-runtime-roundtrip-live] resolving_discord_context");
		const [guild, channel, botUser, health, localChat] = await Promise.all([
			discordRequest<DiscordGuild>(discordToken, `/guilds/${GUILD_ID}`).catch(
				async () => {
					const guilds = await discordRequest<DiscordGuild[]>(
						discordToken,
						"/users/@me/guilds",
					);
					const matched = guilds.find((entry) => entry.name === GUILD_NAME);
					if (!matched) {
						throw new Error(`Could not find guild ${GUILD_NAME}`);
					}
					return matched;
				},
			),
			discordRequest<DiscordChannel>(discordToken, `/channels/${CHANNEL_ID}`),
			discordRequest<{ id: string; username: string }>(
				discordToken,
				"/users/@me",
			),
			waitForJsonPredicate<HealthResponse>(
				`http://127.0.0.1:${runtime.apiPort}/api/health`,
				(value) => value.ready === true && value.runtime === "ok",
				15_000,
			),
			verifyLocalChat(runtime),
		]);
		console.log(
			"[discord-runtime-roundtrip-live] runtime_ready",
			JSON.stringify({
				guildId: guild.id,
				channelId: channel.id,
				channelName: channel.name,
				botUserId: botUser.id,
				apiPort: runtime.apiPort,
			}),
		);

		report.guild = guild;
		report.channel = channel;
		report.botUser = botUser;
		report.health = health;
		report.localChat = localChat;
		report.runtime = {
			apiPort: runtime.apiPort,
			stateDir: runtime.stateDir,
			configPath: runtime.configPath,
			logPath: runtime.logPath,
		};

		const challengeToken = `ELIZA_DISCORD_RUNTIME_QA_${Date.now()}`;
		console.log(
			"[discord-runtime-roundtrip-live] posting_challenge",
			JSON.stringify({ challengeToken, channelId: CHANNEL_ID }),
		);
		const posted = await discordRequest<DiscordMessage>(
			discordToken,
			`/channels/${CHANNEL_ID}/messages`,
			{
				method: "POST",
				body: JSON.stringify({
					content:
						`Discord runtime QA is live on a local Eliza server. Reply directly to this message with \`${challengeToken}\` and mention <@${botUser.id}> so the runtime can answer.\n` +
						`This run is waiting for a real human -> bot roundtrip in ${channel.name}.`,
				}),
			},
		);
		report.postedChallenge = {
			id: posted.id,
			token: challengeToken,
			timestamp: posted.timestamp,
			content: posted.content,
		};
		report.status = "waiting_for_human";
		console.log(
			"[discord-runtime-roundtrip-live] CHALLENGE",
			JSON.stringify({
				reportDir: REPORT_DIR,
				channelId: CHANNEL_ID,
				channelName: channel.name,
				challengeToken,
				messageId: posted.id,
				apiPort: runtime.apiPort,
			}),
		);

		const humanDeadline = Date.now() + TIMEOUT_MS;
		let humanReply: DiscordMessage | null = null;
		console.log(
			"[discord-runtime-roundtrip-live] waiting_for_human",
			JSON.stringify({ challengeToken, timeoutMs: TIMEOUT_MS }),
		);
		while (Date.now() < humanDeadline) {
			const messages = await discordRequest<DiscordMessage[]>(
				discordToken,
				`/channels/${CHANNEL_ID}/messages?limit=50`,
			);
			humanReply =
				messages.find(
					(message) =>
						!message.author.bot &&
						message.timestamp > posted.timestamp &&
						message.content.includes(challengeToken),
				) ?? null;
			if (humanReply) {
				break;
			}
			await sleep(3_000);
		}

		if (!humanReply) {
			report.status = "timed_out_waiting_for_human";
			throw new Error(
				`Timed out waiting for a human reply with ${challengeToken} in ${channel.name}`,
			);
		}

		report.humanReply = {
			id: humanReply.id,
			timestamp: humanReply.timestamp,
			authorId: humanReply.author.id,
			author: humanReply.author.username,
			content: humanReply.content,
		};
		report.status = "waiting_for_bot";
		console.log(
			"[discord-runtime-roundtrip-live] waiting_for_bot",
			JSON.stringify({
				humanReplyId: humanReply.id,
				humanAuthor: humanReply.author.username,
				challengeToken,
				timeoutMs: TIMEOUT_MS,
			}),
		);

		const botDeadline = Date.now() + TIMEOUT_MS;
		let botReply: DiscordMessage | null = null;
		while (Date.now() < botDeadline) {
			const messages = await discordRequest<DiscordMessage[]>(
				discordToken,
				`/channels/${CHANNEL_ID}/messages?limit=50`,
			);
			botReply =
				messages.find(
					(message) =>
						message.author.id === botUser.id &&
						message.timestamp > humanReply.timestamp,
				) ?? null;
			if (botReply) {
				break;
			}
			await sleep(3_000);
		}

		if (!botReply) {
			report.status = "timed_out_waiting_for_bot";
			throw new Error(
				`Timed out waiting for bot reply after human message ${humanReply.id}\n${runtime.getLogTail()}`,
			);
		}

		report.botReply = {
			id: botReply.id,
			timestamp: botReply.timestamp,
			content: botReply.content,
		};
		report.status = "bot_reply_received";
	} catch (error) {
		report.error = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		const markdown = [
			"# Discord Runtime Roundtrip Live Review",
			"",
			`Generated: ${String(report.generatedAt)}`,
			`Report dir: ${REPORT_DIR}`,
			`Status: ${String(report.status)}`,
			"",
			"## Runtime",
			"",
			"```json",
			JSON.stringify(report.runtime, null, 2),
			"```",
			"",
			"## Health",
			"",
			"```json",
			JSON.stringify(report.health, null, 2),
			"```",
			"",
			"## Local Chat Smoke",
			"",
			"```json",
			JSON.stringify(report.localChat, null, 2),
			"```",
			"",
			"## Posted Challenge",
			"",
			"```json",
			JSON.stringify(report.postedChallenge, null, 2),
			"```",
			"",
			"## Human Reply",
			"",
			"```json",
			JSON.stringify(report.humanReply, null, 2),
			"```",
			"",
			"## Bot Reply",
			"",
			"```json",
			JSON.stringify(report.botReply, null, 2),
			"```",
			"",
		].join("\n");

		await writeFile(
			path.join(REPORT_DIR, "report.json"),
			`${JSON.stringify(report, null, 2)}\n`,
			"utf8",
		);
		await writeFile(
			path.join(REPORT_DIR, "report.md"),
			`${markdown}\n`,
			"utf8",
		);

		console.log(
			"[discord-runtime-roundtrip-live] REPORT",
			JSON.stringify({
				reportDir: REPORT_DIR,
				status: report.status,
				challengeToken:
					typeof report.postedChallenge === "object" &&
					report.postedChallenge !== null &&
					"token" in report.postedChallenge
						? (report.postedChallenge as { token: string }).token
						: undefined,
				channelId: CHANNEL_ID,
				apiPort: runtime.apiPort,
			}),
		);

		await runtime.close();
	}
}

try {
	await main();
	process.exit(0);
} catch {
	process.exit(1);
}
