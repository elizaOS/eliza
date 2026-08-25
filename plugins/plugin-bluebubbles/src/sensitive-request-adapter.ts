/**
 * BlueBubbles delivery adapter for sensitive requests.
 *
 * The bridge can only send text through iMessage/SMS, so the adapter delivers
 * secure-link prose and reports explicit failures instead of letting secret or
 * OAuth requests disappear when targeted at a BlueBubbles-backed DM.
 */

import {
	type DeliveryResult,
	type DispatchSensitiveRequest,
	type IAgentRuntime,
	logger,
	type SensitiveRequest,
	type SensitiveRequestDeliveryAdapter,
} from "@elizaos/core";
import { BLUEBUBBLES_SERVICE_NAME } from "./constants";
import type { BlueBubblesService } from "./service";

type BlueBubblesDispatchRequest = DispatchSensitiveRequest &
	Partial<SensitiveRequest>;

const SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE_NAME =
	"SensitiveRequestDispatchRegistry";

function resolveTarget(
	request: BlueBubblesDispatchRequest,
	channelId?: string,
): string | undefined {
	const candidate =
		channelId ?? request.requesterEntityId ?? request.originUserId;
	return typeof candidate === "string" && candidate.trim().length > 0
		? candidate.trim()
		: undefined;
}

function resolveLink(request: BlueBubblesDispatchRequest): string | undefined {
	return request.callback?.url ?? request.delivery?.linkBaseUrl ?? undefined;
}

function buildSensitiveRequestText(
	request: BlueBubblesDispatchRequest,
): string {
	const reason = request.delivery?.reason ?? "A sensitive value is required.";
	const instruction =
		request.delivery?.instruction ??
		"Please open the Eliza app to provide this value.";
	const link = resolveLink(request);
	const lines = ["A sensitive value is needed to continue.", reason];
	lines.push(
		link ? `Open this secure link to provide it: ${link}` : instruction,
	);
	if (request.expiresAt) {
		lines.push(`This request expires at ${request.expiresAt}.`);
	}
	return lines.join("\n");
}

async function deliverViaBlueBubbles(args: {
	request: DispatchSensitiveRequest;
	channelId?: string;
	runtime: unknown;
}): Promise<DeliveryResult> {
	const runtime = args.runtime as IAgentRuntime;
	const request = args.request as BlueBubblesDispatchRequest;
	const target = resolveTarget(request, args.channelId);
	if (!target) {
		return {
			delivered: false,
			target: "dm",
			error:
				"No BlueBubbles chat target available (need targetChannelId or originUserId)",
		};
	}

	const service = runtime.getService?.(BLUEBUBBLES_SERVICE_NAME) as
		| BlueBubblesService
		| null
		| undefined;
	if (!service) {
		return {
			delivered: false,
			target: "dm",
			error: "BlueBubbles service unavailable",
		};
	}

	try {
		await service.sendMessage(target, buildSensitiveRequestText(request));
		return {
			delivered: true,
			target: "dm",
			channelId: target,
			url: resolveLink(request),
			expiresAt: request.expiresAt,
		};
	} catch (err) {
		// error-policy:J1 boundary translation — adapter delivery reports a typed failure result.
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(
			{ src: "bluebubbles:sensitive-request-adapter", err: message },
			"Failed to deliver sensitive request via BlueBubbles",
		);
		return {
			delivered: false,
			target: "dm",
			channelId: target,
			error: message,
		};
	}
}

export const blueBubblesDmSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter =
	{
		target: "dm",
		supportsChannel: (_channelId, runtime) =>
			Boolean(
				(runtime as IAgentRuntime | undefined)?.getService?.(
					BLUEBUBBLES_SERVICE_NAME,
				),
			),
		deliver: (args) => deliverViaBlueBubbles(args),
	};

interface DispatchRegistryLike {
	register: (adapter: SensitiveRequestDeliveryAdapter) => void;
}

export function registerBlueBubblesDmSensitiveRequestAdapter(
	runtime: IAgentRuntime,
): void {
	const tryRegister = (): boolean => {
		const registry = runtime.getService?.(
			SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE_NAME,
		) as DispatchRegistryLike | null | undefined;
		if (!registry || typeof registry.register !== "function") return false;
		try {
			registry.register(blueBubblesDmSensitiveRequestAdapter);
			return true;
		} catch (err) {
			// error-policy:J1 boundary translation — plugin init must continue while the registry observes no adapter.
			logger.warn(
				{
					src: "bluebubbles:sensitive-request-adapter",
					err: err instanceof Error ? err.message : String(err),
				},
				"Failed to register BlueBubbles DM adapter with SensitiveRequestDispatchRegistry",
			);
			return true;
		}
	};

	if (tryRegister()) return;
	setImmediate(() => {
		tryRegister();
	});
}
