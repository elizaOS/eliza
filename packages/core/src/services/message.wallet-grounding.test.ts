/** Reproduces financial reply grounding through the real message service with controlled model responses and a failing local WALLET action. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCharacter } from "../character";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import type {
	Action,
	ActionResult,
	Content,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../types";
import { ModelType } from "../types";
import { ChannelType } from "../types/primitives";
import { DefaultMessageService } from "./message";

const AGENT_ID = "00000000-0000-0000-0000-000000000071" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000072" as UUID;
const INTERNAL_DIAGNOSTIC = "The transfer was rejected by the provider.";

function stageOneWalletResponse(actionName: string) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "Run the requested transfer.",
					contexts: ["general"],
					intents: ["transfer funds"],
					candidateActionNames: [actionName],
					replyText: "",
					facts: [],
					relationships: [],
					addressedTo: [],
					requiresTool: true,
				},
			},
		],
		finishReason: "tool_calls",
	};
}

function plannerWalletCall(actionName: string) {
	return {
		thought: "Run the requested transfer.",
		toolCalls: [
			{
				id: "wallet-list-1",
				name: actionName,
				args: { action: "transfer" },
			},
		],
	};
}

function plannerFinish(messageToUser: string) {
	return JSON.stringify({
		success: true,
		decision: "FINISH",
		thought: "Return the selected result.",
		messageToUser,
	});
}

function makeMessage(runtime: AgentRuntime, text: string): Memory {
	return {
		entityId: USER_ID,
		agentId: runtime.agentId,
		roomId: runtime.agentId,
		content: {
			text,
			source: "client_chat",
			channelType: ChannelType.DM,
		},
		createdAt: Date.now(),
	};
}

interface Harness {
	runtime: AgentRuntime;
	actionHandler: ReturnType<typeof vi.fn>;
	callback: HandlerCallback;
	callbacks: Content[];
	callbackActionNames: Array<string | undefined>;
	sent: Content[];
	voiceHandler: ReturnType<typeof vi.fn>;
}

const activeRuntimes: AgentRuntime[] = [];

async function createHarness(
	finalText: string,
	actionCallbackText?: string,
	actionResult?: ActionResult,
	rewriteText = "The provider did not submit the transfer.",
): Promise<Harness> {
	const runtime = new AgentRuntime({
		character: createCharacter({
			id: AGENT_ID,
			name: "Wallet Grounding Integration",
			bio: "Exercises the real message-service delivery boundary.",
			settings: { ELIZA_ADMIN_ENTITY_ID: USER_ID },
		}),
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
		enableAutonomy: false,
	});
	await runtime.initialize({ skipMigrations: true });
	activeRuntimes.push(runtime);
	await runtime.ensureConnection({
		entityId: USER_ID,
		roomId: AGENT_ID,
		worldId: AGENT_ID,
		userName: "owner",
		name: "owner",
		source: "client_chat",
		type: ChannelType.DM,
	});

	// Preserve the real runtime registries and storage while keeping prompt
	// composition deterministic and independent of unrelated provider output.
	runtime.actions.length = 0;
	runtime.evaluators.length = 0;
	runtime.composeState = vi.fn(async () => {
		return {
			values: { availableContexts: "general" },
			data: {},
			text: "Deterministic wallet-grounding state.",
		} as State;
	}) as AgentRuntime["composeState"];

	const actionHandler = vi.fn(
		async (
			_runtime,
			_message,
			_state,
			_options,
			actionCallback?: HandlerCallback,
		) => {
			if (actionCallbackText) {
				await actionCallback?.({
					text: actionCallbackText,
					actions: ["WALLET"],
				});
			}
			if (actionResult) return actionResult;
			return {
				success: false,
				text: INTERNAL_DIAGNOSTIC,
				values: { walletActionError: "EXECUTION_FAILED" },
				data: { error: "EXECUTION_FAILED", detail: INTERNAL_DIAGNOSTIC },
			};
		},
	);
	const actionName =
		typeof actionResult?.data?.actionName === "string"
			? actionResult.data.actionName
			: "WALLET";
	const walletAction: Action = {
		name: actionName,
		description: "Submits a wallet transfer.",
		parameters: [
			{
				name: "action",
				description: "Wallet operation",
				required: true,
				schema: { type: "string", enum: ["transfer"] },
			},
		],
		validate: async () => true,
		handler: actionHandler,
	};
	runtime.registerAction(walletAction);

	const responseQueue = [
		stageOneWalletResponse(actionName),
		plannerFinish(finalText),
	];
	const responseHandler = vi.fn(async () => {
		const next = responseQueue.shift();
		if (next === undefined) {
			throw new Error("Unexpected RESPONSE_HANDLER model call");
		}
		return next;
	});
	const plannerQueue = [plannerWalletCall(actionName)];
	const plannerHandler = vi.fn(async () => {
		const next = plannerQueue.shift();
		if (next === undefined) {
			throw new Error("Unexpected ACTION_PLANNER model call");
		}
		return next;
	});
	const voiceHandler = vi.fn(
		async (_runtime: IAgentRuntime, params: { prompt: string }) =>
			params.prompt.startsWith("Compose a user-facing response")
				? JSON.stringify({ response: rewriteText })
				: rewriteText,
	);
	runtime.registerModel(
		ModelType.RESPONSE_HANDLER,
		responseHandler,
		"wallet-grounding-test",
		100,
	);
	runtime.registerModel(
		ModelType.ACTION_PLANNER,
		plannerHandler,
		"wallet-grounding-test",
		100,
	);
	runtime.registerModel(
		ModelType.TEXT_SMALL,
		voiceHandler,
		"wallet-grounding-test",
		100,
	);

	const callbacks: Content[] = [];
	const callbackActionNames: Array<string | undefined> = [];
	const sent: Content[] = [];
	runtime.registerSendHandler(
		"client_chat",
		async (_runtime, _target, content) => {
			sent.push(content);
			return undefined;
		},
	);

	const callback: HandlerCallback = async (content: Content, actionName) => {
		callbacks.push(content);
		callbackActionNames.push(actionName);
		await runtime.sendMessageToTarget(
			{ source: "client_chat", roomId: runtime.agentId },
			content,
		);
		return [];
	};

	return {
		runtime,
		actionHandler,
		callback,
		callbacks,
		callbackActionNames,
		sent,
		voiceHandler,
	};
}

beforeEach(() => {
	vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "0");
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		activeRuntimes.splice(0).map(async (runtime) => {
			await runtime.stop();
			await runtime.close();
		}),
	);
});

function submitted(
	subaction: string,
	overrides: Record<string, string | boolean> = {},
): ActionResult {
	return {
		success: true,
		text:
			overrides.status === "prepared"
				? `Prepared ${subaction} on solana.`
				: overrides.status === "simulated"
					? `Simulated ${subaction} on solana.`
					: `Submitted ${subaction} on solana: controlled-provider-receipt`,
		values: {
			walletActionSucceeded: true,
			walletActionPrepared: false,
			walletActionSimulated: false,
			walletChain: "solana",
			walletSubaction: subaction,
		},
		data: {
			status: "submitted",
			chain: "solana",
			chainId: "mainnet",
			subaction,
			dryRun: false,
			mode: "execute",
			signature: "controlled-provider-receipt",
			...overrides,
		},
	};
}
async function deliver(
	finalText: string,
	actionResult?: ActionResult,
	rewriteText?: string,
	request = "Transfer 1 SOL to the requested recipient.",
) {
	const harness = await createHarness(
		finalText,
		undefined,
		actionResult,
		rewriteText,
	);
	const result = await new DefaultMessageService().handleMessage(
		harness.runtime,
		makeMessage(harness.runtime, request),
		harness.callback,
	);
	expect(harness.actionHandler).toHaveBeenCalledTimes(1);
	expect(result.actionResults).toHaveLength(1);
	const stored = await harness.runtime.getMemories({
		roomId: harness.runtime.agentId,
		tableName: "messages",
	});
	return {
		harness,
		result,
		texts: harness.callbacks.map((content) => content.text),
		stored: stored
			.filter((memory) => memory.entityId === harness.runtime.agentId)
			.map((memory) => memory.content.text),
	};
}

it("keeps a failed financial action honest through the real planner and delivery", async () => {
	const { harness, result, texts, stored } = await deliver(
		"The transfer was submitted.",
	);
	expect(result.actionResults?.[0]?.success).toBe(false);
	expect(texts).not.toContain("The transfer was submitted.");
	expect(stored).not.toContain("The transfer was submitted.");
	expect(harness.sent.map((content) => content.text)).not.toContain(
		"The transfer was submitted.",
	);
	expect(
		texts.some(
			(text) => text?.includes("failed") || text?.includes("did not submit"),
		),
	).toBe(true);
});

it.each([
	["different submitted operation", submitted("swap")],
	[
		"prepared transfer",
		submitted("transfer", { status: "prepared", mode: "prepare" }),
	],
	[
		"simulated transfer",
		submitted("transfer", { status: "simulated", mode: "simulate" }),
	],
	["dry-run transfer", submitted("transfer", { dryRun: true })],
	["missing provider proof", submitted("transfer", { signature: "" })],
	["malformed router subaction", submitted("send_message")],
] satisfies Array<[string, ActionResult]>)(
	"rewrites unsupported completion after %s without replaying the action",
	async (_label, actionResult) => {
		const { harness, texts, stored } = await deliver(
			"The transfer was submitted.",
			actionResult,
			"The requested transfer has not been verified.",
		);
		expect(texts).not.toContain("The transfer was submitted.");
		expect(stored).not.toContain("The transfer was submitted.");
		expect(texts).toContain("The requested transfer has not been verified.");
		expect(harness.sent.map((content) => content.text)).toEqual(texts);
		expect(
			harness.voiceHandler.mock.calls.some((call) =>
				JSON.stringify(call[1]).includes("financial_completion"),
			),
		).toBe(true);
	},
);

it.each(["transfer", "swap", "bridge"])(
	"preserves a matching submitted %s outcome",
	async (subaction) => {
		const finalText = `The ${subaction} was submitted.`;
		const { texts, stored } = await deliver(finalText, submitted(subaction));
		expect(texts).toContain(finalText);
		expect(stored).toContain(finalText);
	},
);

it("keeps a read-only wallet observation distinct from mutation submission", async () => {
	const finalText = "Your wallet portfolio contains 4 SOL.";
	const observation: ActionResult = {
		success: true,
		text: "Portfolio for controlled-wallet: SOL uiAmount 4",
		data: {
			subaction: "search_address",
			target: "birdeye",
			results: [
				{
					address: "controlled-wallet",
					chain: "solana",
					result: {
						success: true,
						data: {
							wallet: "controlled-wallet",
							totalUsd: 400,
							items: [{ symbol: "SOL", uiAmount: 4 }],
						},
					},
				},
			],
		},
	};
	const { texts, stored } = await deliver(finalText, observation);
	expect(texts).toContain(finalText);
	expect(stored).toContain(finalText);
});

it("does not confuse queued governance with executed governance", async () => {
	const queued = submitted("gov");
	queued.data = { ...queued.data, metadata: { op: "queue" } };
	const { texts, stored } = await deliver(
		"The governance proposal was executed.",
		queued,
		"The governance queue transaction was submitted; execution is not verified.",
	);
	expect(texts).toContain(
		"The governance queue transaction was submitted; execution is not verified.",
	);
	expect(stored).not.toContain("The governance proposal was executed.");
});
it("preserves matching governance execution submission evidence", async () => {
	const executed = submitted("gov");
	executed.data = { ...executed.data, metadata: { op: "execute" } };
	const reply = "The governance proposal execution was submitted.";
	const { texts, stored } = await deliver(reply, executed);
	expect(texts).toContain(reply);
	expect(stored).toContain(reply);
});
it("does not turn trading account inspection into an order submission", async () => {
	const inspection: ActionResult = {
		success: true,
		text: "Hyperliquid governed account is active.",
		verifiedUserFacing: true,
		data: { actionName: "TRADE", account: { id: "controlled-account" } },
		values: { tradeOutcome: "not_attempted", tradeVenue: "hyperliquid" },
	};
	const { texts, stored } = await deliver(
		"The Hyperliquid order was submitted.",
		inspection,
		"The account is active; an order submission is not verified.",
	);
	expect(texts).toContain(
		"The account is active; an order submission is not verified.",
	);
	expect(stored).not.toContain("The Hyperliquid order was submitted.");
});
it("preserves a submitted trading order with provider order proof", async () => {
	const order: ActionResult = {
		success: true,
		text: "Submitted hyperliquid order controlled-order.",
		verifiedUserFacing: true,
		data: {
			actionName: "TRADE",
			success: true,
			outcome: "submitted",
			venue: "hyperliquid",
			order: { orderId: "controlled-order" },
			idempotencyKey: "controlled-key",
		},
		values: {
			tradeActionSucceeded: true,
			tradeVenue: "hyperliquid",
			tradeOrderId: "controlled-order",
		},
	};
	const reply = "The Hyperliquid order was submitted.";
	const { texts, stored } = await deliver(reply, order);
	expect(texts).toContain(reply);
	expect(stored).toContain(reply);
});

it("does not let future settlement wording hide a false submission", async () => {
	const reply = "The transfer was submitted and will settle soon.";
	const { texts, stored } = await deliver(
		reply,
		submitted("swap"),
		"A transfer submission is not verified.",
	);
	expect(texts).toContain("A transfer submission is not verified.");
	expect(stored).not.toContain(reply);
});
it("keeps a denial separate from a later unsupported completion", async () => {
	const reply = "The swap was not submitted, but the transfer was submitted.";
	const { texts, stored } = await deliver(
		reply,
		submitted("swap"),
		"A transfer submission is not verified.",
	);
	expect(texts).toContain("A transfer submission is not verified.");
	expect(stored).not.toContain(reply);
});

it.each(["completed", "confirmed", "settled", "finalized"])(
	"does not promote submission evidence into a %s transfer",
	async (status) => {
		const reply = `The transfer was ${status}.`;
		const { texts, stored } = await deliver(
			reply,
			submitted("transfer"),
			"The transfer was submitted; final settlement is not verified.",
		);
		expect(texts).toContain(
			"The transfer was submitted; final settlement is not verified.",
		);
		expect(stored).not.toContain(reply);
	},
);

it("fails closed when the response model repeats a false operation and invents proof", async () => {
	const falseClaim = "I submitted the transfer of 1 SOL.";
	const harness = await createHarness(
		"The transfer was submitted.",
		undefined,
		submitted("swap"),
	);
	harness.voiceHandler.mockResolvedValue(
		JSON.stringify({
			response: falseClaim,
			effectReceiptIds: ["controlled-provider-receipt"],
		}),
	);
	await expect(
		new DefaultMessageService().handleMessage(
			harness.runtime,
			makeMessage(
				harness.runtime,
				"Transfer 1 SOL to the requested recipient.",
			),
			harness.callback,
		),
	).rejects.toMatchObject({ code: "REPLY_GROUNDING_FAILED" });
	expect(harness.actionHandler).toHaveBeenCalledTimes(1);
	expect(harness.callbacks).toEqual([]);
	expect(harness.sent).toEqual([]);
	const stored = await harness.runtime.getMemories({
		roomId: harness.runtime.agentId,
		tableName: "messages",
	});
	expect(
		stored.filter((memory) => memory.entityId === harness.runtime.agentId),
	).toEqual([]);
});

it("does not mistake an explicitly named SOL swap for a transfer", async () => {
	const reply =
		"Submitted a 1 SOL swap on Solana mainnet; confirmation is not yet verified.";
	const swap = submitted("swap");
	swap.data = {
		...swap.data,
		amount: "1",
		fromToken: "So11111111111111111111111111111111111111112",
		toToken: "controlled-output-mint",
	};
	const { texts, stored } = await deliver(reply, swap);
	expect(texts).toContain(reply);
	expect(stored).toContain(reply);
});

it("does not let a submitted swap prove an additional token transfer", async () => {
	const reply = "I submitted a swap and sent 1 SOL to the recipient.";
	const { texts, stored } = await deliver(
		reply,
		submitted("swap"),
		"The swap was submitted; a transfer is not verified.",
	);
	expect(texts).toContain(
		"The swap was submitted; a transfer is not verified.",
	);
	expect(stored).not.toContain(reply);
});

it.each(["SEND_EMAIL", "SEND_MESSAGE", "SEARCH"])(
	"does not use a successful %s result as a requested wallet transfer",
	async (actionName) => {
		const unrelated: ActionResult = {
			success: true,
			text: "Requested non-financial step finished.",
			data: { actionName },
		};
		const { texts, stored } = await deliver(
			"The transfer was submitted.",
			unrelated,
			"A wallet transfer submission is not verified.",
		);
		expect(texts).toContain("A wallet transfer submission is not verified.");
		expect(stored).not.toContain("The transfer was submitted.");
	},
);

it("preserves a nonfinancial file transfer without requiring a wallet result", async () => {
	const reply = "The file transfer was submitted.";
	const fileResult: ActionResult = {
		success: true,
		text: "Upload accepted: controlled-document",
		data: { actionName: "UPLOAD_FILE", file: "controlled-document" },
	};
	const { texts, stored } = await deliver(
		reply,
		fileResult,
		undefined,
		"Transfer this document to the requested folder.",
	);
	expect(texts).toContain(reply);
	expect(stored).toContain(reply);
});
