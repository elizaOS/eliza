import {
	type DeliveryResult,
	type DispatchSensitiveRequest,
	type IAgentRuntime,
	logger,
	type SensitiveRequest,
	type SensitiveRequestDeliveryAdapter,
} from "@elizaos/core";
import type { UserResolvable } from "discord.js";
import { DISCORD_SERVICE_NAME } from "./constants";
import type { DiscordService } from "./service";

// The Discord adapter receives the dispatch shape but reads policy-side
// fields (`delivery`, `callback`, `requesterEntityId`) when present. We
// type-narrow at the boundary via a permissive intersection.
type DiscordDispatchRequest = DispatchSensitiveRequest &
	Partial<SensitiveRequest>;

const SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE_NAME =
	"SensitiveRequestDispatchRegistry";

interface DiscordSendDmDeps {
	getDiscordService(runtime: IAgentRuntime): DiscordService | null;
}

const defaultDeps: DiscordSendDmDeps = {
	getDiscordService(runtime) {
		const svc = runtime.getService?.(DISCORD_SERVICE_NAME) as
			| DiscordService
			| null
			| undefined;
		return svc ?? null;
	},
};

function isCloudPaired(runtime: IAgentRuntime): boolean {
	const apiKey = runtime.getSetting?.("ELIZA_CLOUD_API_KEY");
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function buildDmBody(
	request: DiscordDispatchRequest,
	runtime: IAgentRuntime,
): string {
	const reason = request.delivery?.reason ?? "A sensitive value is required.";
	const instruction =
		request.delivery?.instruction ??
		"Please open the Eliza app private chat to provide this value.";

	if (request.kind === "secret" && isCloudPaired(runtime)) {
		const link =
			request.callback?.url ?? request.delivery?.linkBaseUrl ?? undefined;
		if (link) {
			return [
				"A sensitive value is needed to continue.",
				reason,
				`Open this secure link to provide it: ${link}`,
				`This link expires at ${request.expiresAt}.`,
			].join("\n");
		}
	}

	return [
		"A sensitive value is needed to continue.",
		reason,
		instruction,
		`This request expires at ${request.expiresAt}.`,
	].join("\n");
}

async function deliverViaDiscordDm(
	args: {
		request: DispatchSensitiveRequest;
		channelId?: string;
		runtime: unknown;
	},
	deps: DiscordSendDmDeps,
): Promise<DeliveryResult> {
	const runtime = args.runtime as IAgentRuntime;
	const request = args.request as DiscordDispatchRequest;
	const candidateDiscordUserId =
		args.channelId ?? request.requesterEntityId ?? request.originUserId;
	const discordUserId: string | null =
		typeof candidateDiscordUserId === "string" ? candidateDiscordUserId : null;

	if (!discordUserId) {
		return {
			delivered: false,
			target: "dm",
			error:
				"No Discord user id available (need targetChannelId or originUserId)",
		};
	}

	const discordService = deps.getDiscordService(runtime);
	if (!discordService?.client) {
		return {
			delivered: false,
			target: "dm",
			error: "Discord service unavailable",
		};
	}

	try {
		const user = await discordService.client.users.fetch(
			discordUserId as UserResolvable,
		);
		const dmChannel = await user.createDM();
		await dmChannel.send({ content: buildDmBody(request, runtime) });
		return {
			delivered: true,
			target: "dm",
			channelId: dmChannel.id,
			expiresAt: request.expiresAt,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(
			{ src: "discord:sensitive-request-adapter", err: message },
			"Failed to deliver sensitive request DM",
		);
		return { delivered: false, target: "dm", error: message };
	}
}

export const discordDmSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter =
	{
		target: "dm",
		supportsChannel: (_channelId, runtime) => {
			const svc = (runtime as IAgentRuntime | undefined)?.getService?.(
				DISCORD_SERVICE_NAME,
			) as DiscordService | null | undefined;
			return Boolean(svc?.client);
		},
		deliver: (args) => deliverViaDiscordDm(args, defaultDeps),
	};

/**
 * Internal factory used by tests so the Discord client lookup can be mocked
 * without standing up a real DiscordService instance.
 */
export function createDiscordDmSensitiveRequestAdapter(
	deps: DiscordSendDmDeps,
): SensitiveRequestDeliveryAdapter {
	return {
		target: "dm",
		supportsChannel: (_channelId, runtime) =>
			Boolean(deps.getDiscordService(runtime as IAgentRuntime)?.client),
		deliver: (args) => deliverViaDiscordDm(args, deps),
	};
}

interface DispatchRegistryLike {
	register: (adapter: SensitiveRequestDeliveryAdapter) => void;
}

/**
 * Registers the Discord DM adapter into the runtime's
 * SensitiveRequestDispatchRegistry, if one is available. Safe to call
 * multiple times and from any plugin lifecycle hook; never throws.
 */
export function registerDiscordDmSensitiveRequestAdapter(
	runtime: IAgentRuntime,
): void {
	const tryRegister = (): boolean => {
		const registry = runtime.getService?.(
			SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE_NAME,
		) as unknown as DispatchRegistryLike | null | undefined;
		if (!registry || typeof registry.register !== "function") return false;
		try {
			registry.register(discordDmSensitiveRequestAdapter);
			return true;
		} catch (err) {
			logger.warn(
				{
					src: "discord:sensitive-request-adapter",
					err: err instanceof Error ? err.message : String(err),
				},
				"Failed to register Discord DM adapter with SensitiveRequestDispatchRegistry",
			);
			return true; // do not retry on a hard failure
		}
	};

	if (tryRegister()) return;
	// Registry may register slightly after plugin init; defer once.
	setImmediate(() => {
		tryRegister();
	});
}
