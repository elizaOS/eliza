import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
};

type DiscordChannel = {
	id: string;
	name: string;
	type: number;
	parent_id?: string | null;
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

const DEFAULT_GUILD_NAME = process.env.DISCORD_QA_GUILD_NAME ?? "Cozy Devs";
const DEFAULT_GUILD_ID =
	process.env.DISCORD_QA_GUILD_ID ?? "1051457140637827122";
const POST_CHALLENGE = process.env.ELIZA_DISCORD_QA_POST === "1";
const WAIT_FOR_HUMAN = process.env.ELIZA_DISCORD_QA_WAIT_FOR_HUMAN === "1";
const EXPECT_BOT_RESPONSE =
	process.env.ELIZA_DISCORD_QA_EXPECT_BOT_RESPONSE === "1";
const TIMEOUT_MS = Math.max(
	30_000,
	Number.parseInt(process.env.DISCORD_QA_TIMEOUT_MS ?? "", 10) || 10 * 60_000,
);

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

function rankChannels(channels: DiscordChannel[]): DiscordChannel[] {
	const textChannels = channels.filter((channel) => channel.type === 0);
	const explicitId = process.env.DISCORD_QA_CHANNEL_ID;
	if (explicitId) {
		const explicit = textChannels.find((channel) => channel.id === explicitId);
		return explicit ? [explicit] : [];
	}

	const scored = textChannels
		.map((channel) => {
			let score = 0;
			if (/(testing|test|bot-commands|sandbox)/i.test(channel.name))
				score += 100;
			if (/(bot|commands|qa)/i.test(channel.name)) score += 50;
			if (/(agent|arena)/i.test(channel.name)) score += 20;
			if (/(dev|core)/i.test(channel.name)) score -= 10;
			if (/(moderator|rules|news|feed|reviewers|releases)/i.test(channel.name))
				score -= 100;
			return { channel, score };
		})
		.sort((left, right) => right.score - left.score);

	return scored.map((entry) => entry.channel);
}

function pollDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const repoRoot = process.cwd();
const qaRoot = path.join(repoRoot, ".tmp", "qa");
fs.mkdirSync(qaRoot, { recursive: true });
const reportDir = fs.mkdtempSync(path.join(qaRoot, "discord-channel-review-"));

const token = loadDiscordToken();
const botUser = await discordRequest<{ id: string; username: string }>(
	token,
	"/users/@me",
);

let guild: DiscordGuild | null = null;
try {
	const guilds = await discordRequest<DiscordGuild[]>(
		token,
		"/users/@me/guilds",
	);
	guild = guilds.find((entry) => entry.name === DEFAULT_GUILD_NAME) ?? null;
} catch {
	guild = null;
}

if (!guild) {
	guild = await discordRequest<DiscordGuild>(
		token,
		`/guilds/${DEFAULT_GUILD_ID}`,
	);
}

const channels = await discordRequest<DiscordChannel[]>(
	token,
	`/guilds/${guild.id}/channels`,
);
const rankedChannels = rankChannels(channels);
const selectedChannel = rankedChannels[0] ?? null;
if (!selectedChannel) {
	throw new Error(
		`No usable Discord text channel found in guild ${guild.name}`,
	);
}
let activeChannel = selectedChannel;

const report: Record<string, unknown> = {
	generatedAt: new Date().toISOString(),
	reportDir,
	guild,
	botUser,
	selectedChannel,
	candidateChannels: channels
		.filter((channel) => channel.type === 0)
		.map((channel) => ({ id: channel.id, name: channel.name })),
	attemptedPostChannels: [],
	postedChallenge: null,
	humanReply: null,
	botReply: null,
	status: "discovered",
};

if (POST_CHALLENGE) {
	const tokenSuffix = `${Date.now()}`;
	const challengeToken = `ELIZA_DISCORD_QA_${tokenSuffix}`;
	let posted: DiscordMessage | null = null;
	let postingChannel = selectedChannel;
	let lastError = "";

	for (const candidate of rankedChannels) {
		report.attemptedPostChannels = [
			...((report.attemptedPostChannels as
				| Array<{ id: string; name: string }>
				| undefined) ?? []),
			{ id: candidate.id, name: candidate.name },
		];
		try {
			posted = await discordRequest<DiscordMessage>(
				token,
				`/channels/${candidate.id}/messages`,
				{
					method: "POST",
					body: JSON.stringify({
						content:
							`Task-agent Discord QA challenge: reply in this channel with \`${challengeToken}\` to trigger the live roundtrip review.\n` +
							`This review will wait for a human reply${EXPECT_BOT_RESPONSE ? " and then for a bot response" : ""}.`,
					}),
				},
			);
			postingChannel = candidate;
			break;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
	}

	if (!posted) {
		throw new Error(
			`Unable to post a Discord QA challenge in ${guild.name}. Last error: ${lastError}`,
		);
	}

	report.postedChallenge = {
		id: posted.id,
		token: challengeToken,
		timestamp: posted.timestamp,
		content: posted.content,
	};
	report.selectedChannel = postingChannel;
	activeChannel = postingChannel;
	report.status = WAIT_FOR_HUMAN ? "waiting_for_human" : "posted";

	if (WAIT_FOR_HUMAN) {
		const deadline = Date.now() + TIMEOUT_MS;
		while (Date.now() < deadline) {
			const messages = await discordRequest<DiscordMessage[]>(
				token,
				`/channels/${postingChannel.id}/messages?limit=50`,
			);
			const humanReply = messages.find(
				(message) =>
					!message.author.bot &&
					message.timestamp > posted.timestamp &&
					message.content.includes(challengeToken),
			);

			if (humanReply) {
				report.humanReply = {
					id: humanReply.id,
					authorId: humanReply.author.id,
					author: humanReply.author.username,
					timestamp: humanReply.timestamp,
					content: humanReply.content,
				};
				report.status = EXPECT_BOT_RESPONSE
					? "waiting_for_bot"
					: "human_reply_received";

				if (!EXPECT_BOT_RESPONSE) {
					break;
				}

				const botDeadline = Date.now() + TIMEOUT_MS;
				while (Date.now() < botDeadline) {
					const refreshed = await discordRequest<DiscordMessage[]>(
						token,
						`/channels/${postingChannel.id}/messages?limit=50`,
					);
					const botReply = refreshed.find(
						(message) =>
							message.author.id === botUser.id &&
							message.timestamp > humanReply.timestamp,
					);
					if (botReply) {
						report.botReply = {
							id: botReply.id,
							timestamp: botReply.timestamp,
							content: botReply.content,
						};
						report.status = "bot_reply_received";
						break;
					}
					await pollDelay(3000);
				}
				break;
			}

			await pollDelay(3000);
		}

		if (
			report.status === "waiting_for_human" ||
			report.status === "waiting_for_bot"
		) {
			report.status = "timed_out";
		}
	}
}

const markdown = [
	"# Discord Channel Roundtrip Review",
	"",
	`Generated: ${String(report.generatedAt)}`,
	`Guild: ${guild.name} (${guild.id})`,
	`Bot user: ${botUser.username} (${botUser.id})`,
	`Selected channel: ${activeChannel.name} (${activeChannel.id})`,
	`Status: ${String(report.status)}`,
	"",
	"## Candidate Channels",
	"",
	...((report.candidateChannels as Array<{ id: string; name: string }>).map(
		(channel) => `- ${channel.name} (${channel.id})`,
	) || []),
	"",
	...(report.postedChallenge
		? [
				"## Posted Challenge",
				"",
				"```json",
				JSON.stringify(report.postedChallenge, null, 2),
				"```",
				"",
			]
		: []),
	...(report.humanReply
		? [
				"## Human Reply",
				"",
				"```json",
				JSON.stringify(report.humanReply, null, 2),
				"```",
				"",
			]
		: []),
	...(report.botReply
		? [
				"## Bot Reply",
				"",
				"```json",
				JSON.stringify(report.botReply, null, 2),
				"```",
				"",
			]
		: []),
].join("\n");

fs.writeFileSync(
	path.join(reportDir, "report.json"),
	`${JSON.stringify(report, null, 2)}\n`,
);
fs.writeFileSync(path.join(reportDir, "report.md"), `${markdown}\n`);

console.log(
	"[discord-channel-roundtrip-review] REPORT",
	JSON.stringify({
		reportDir,
		guildId: guild.id,
		channelId: activeChannel.id,
		status: report.status,
	}),
);

process.exit(report.status === "timed_out" ? 1 : 0);
