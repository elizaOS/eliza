import { describe, expect, it, vi } from "vitest";
import { deriveCanonicalProvenance } from "../../access-control/provenance-envelope";
import {
	createMessageMemory,
	stampAppConversationProvenance,
} from "../../memory";
import { attestAuthenticatedApiDeliveryAudience } from "../../security/trusted-delivery-audience";
import type { IAgentRuntime, State, UUID } from "../../types";
import { createV5ReplyStrategyResult } from "./reply-policy";

const agent = "22222222-2222-2222-2222-222222222222" as UUID;
const owner = "11111111-1111-1111-1111-111111111111" as UUID;
const room = "44444444-4444-4444-4444-444444444444" as UUID;
const replyId = "55555555-5555-5555-5555-555555555555" as UUID;
function setup() {
	const runtime = {
		agentId: agent,
		getParticipantsForRoom: vi.fn(async () => [owner, agent]),
		getSetting: (key: string) =>
			key === "ELIZA_ADMIN_ENTITY_ID" ? owner : undefined,
		reportError: vi.fn(),
		logger: { debug: vi.fn(), warn: vi.fn() },
	} as unknown as IAgentRuntime;
	const message = stampAppConversationProvenance(
		agent,
		createMessageMemory({
			id: "66666666-6666-6666-6666-666666666666" as UUID,
			agentId: agent,
			entityId: owner,
			roomId: room,
			content: { text: "hi", source: "client_chat" },
		}),
	);
	return { runtime, message };
}
describe("app reply provenance", () => {
	it.each([
		"trusted",
		"unattested",
		"cloned",
		"other-runtime",
		"connector",
		"other-account",
		"other-record",
		"other-room",
	])("preserves boundary for %s turn", async (mode) => {
		const { runtime, message } = setup();
		if (mode !== "unattested")
			await attestAuthenticatedApiDeliveryAudience(runtime, message, {
				kind: "owner_session",
				principalId: "owner",
			});
		if (mode === "connector") message.metadata.provider = "discord";
		if (mode === "other-account")
			message.metadata.accountId = "another-account";
		if (mode === "other-record")
			message.metadata.platformMessageId = "another-record";
		if (mode === "other-room")
			message.roomId = "77777777-7777-7777-7777-777777777777" as UUID;
		const incoming = structuredClone(message);
		const result = createV5ReplyStrategyResult({
			runtime: mode === "other-runtime" ? { ...runtime } : runtime,
			message: mode === "cloned" ? structuredClone(message) : message,
			state: {} as State,
			responseId: replyId,
			text: "Exact  text.\nΩ",
			thought: "",
		});
		const reply = result.responseMessages[0];
		expect(reply.content.text).toBe("Exact  text.\nΩ");
		expect(reply.entityId).toBe(agent);
		expect(reply.roomId).toBe(message.roomId);
		expect(structuredClone(message)).toEqual(incoming);
		if (mode === "trusted") {
			expect(reply.metadata).toMatchObject({
				provider: "client_chat",
				accountId: agent,
				platformMessageId: replyId,
				sourceId: replyId,
				scope: "private",
			});
			expect(deriveCanonicalProvenance(reply, agent).valid).toBe(true);
			expect(reply.metadata?.platformMessageId).not.toBe(message.id);
		} else expect(reply.metadata).toBeUndefined();
	});
	it("keeps existing source identity and scope when stamping an incoming record", () => {
		const { message } = setup();
		message.metadata.scope = "shared";
		message.metadata.accountId = "existing";
		message.metadata.platformMessageId = "external-id";
		const stamped = stampAppConversationProvenance(agent, message);
		expect(stamped).toBe(message);
		expect(stamped.metadata).toMatchObject({
			scope: "shared",
			accountId: "existing",
			platformMessageId: "external-id",
		});
	});
});
