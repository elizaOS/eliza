/**
 * Live e2e for READ_ATTACHMENT.
 *
 * Replaces the deleted mocked unit suite (which mocked `useModel` to return
 * canned strings then asserted the canned strings flowed through). This test
 * exercises the action against a real `AgentRuntime` wired to a live LLM via
 * the OpenAI plugin (Cerebras alias). It feeds a text attachment containing a
 * deterministic secret token and asserts the LLM-generated reply contains it.
 *
 * Skips with a yellow warning when neither CEREBRAS_API_KEY nor OPENAI_API_KEY
 * is set — `describeLive` handles the no-key case and annotates SKIP_REASON so
 * the silent-skip guard does not trip.
 */

import { v4 as uuidv4 } from "uuid";
import { expect, it } from "vitest";

import { describeLive } from "../../../app-core/test/helpers/live-agent-test";
import { readAttachmentAction } from "../features/working-memory/readAttachmentAction.ts";
import type { HandlerCallback, Media, Memory, UUID } from "../types";
import { ContentType } from "../types";

describeLive(
	"READ_ATTACHMENT live (Cerebras)",
	{ requiredEnv: ["OPENAI_API_KEY"] },
	({ harness }) => {
		it("reads a text attachment and returns a real LLM answer containing the secret token", async () => {
			const { runtime, agentId } = harness();

			const secret = "saffron-anchor-7421";
			const attachment: Media = {
				id: "attachment-1",
				url: "https://example.test/attachment-1.txt",
				title: "secret.txt",
				source: "Plaintext",
				contentType: ContentType.DOCUMENT,
				text: `Secret phrase: ${secret}\nReturn only the secret phrase, nothing else.`,
			};

			const message: Memory = {
				id: uuidv4() as UUID,
				agentId,
				entityId: uuidv4() as UUID,
				roomId: uuidv4() as UUID,
				createdAt: Date.now(),
				content: {
					text: "read this attachment and reply with only the secret phrase",
					source: "live-test",
					attachments: [attachment],
				},
			};

			let callbackText = "";
			const callback: HandlerCallback = async (content) => {
				if (typeof content?.text === "string") callbackText = content.text;
				return [];
			};

			const result = await readAttachmentAction.handler?.(
				runtime,
				message,
				undefined,
				undefined,
				callback,
			);

			expect(result?.success).toBe(true);
			expect(typeof result?.text).toBe("string");
			expect(callbackText.length).toBeGreaterThan(0);
			expect(callbackText.toLowerCase()).toContain(secret.toLowerCase());
			expect(String(result?.text).toLowerCase()).toContain(
				secret.toLowerCase(),
			);
		}, 120_000);
	},
);
