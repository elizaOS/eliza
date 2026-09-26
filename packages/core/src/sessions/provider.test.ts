import { expect, it } from "vitest";
import type { Memory } from "../types/memory.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import type { State } from "../types/state.ts";
import { createSendPolicyProvider, extractSessionContext } from "./provider.ts";

it("preserves metadata session policy when a connector supplies empty direct IDs", async () => {
	const message = {
		sessionId: "",
		sessionKey: "",
		content: { text: "hello" },
		metadata: {
			sessionId: "metadata-id",
			sessionKey: "metadata-key",
			session: { sessionId: "entry-id", sendPolicy: "deny" },
		},
	} as Memory;
	expect(extractSessionContext(message)).toMatchObject({
		sessionId: "metadata-id",
		sessionKey: "metadata-key",
		entry: { sendPolicy: "deny" },
	});
	const result = await createSendPolicyProvider().get(
		{} as IAgentRuntime,
		message,
		{} as State,
	);
	expect(result.values).toEqual({ sendPolicy: "deny", canSend: false });
	expect(result.text).toContain("SEND POLICY: DENY");
	expect(
		extractSessionContext({
			...message,
			sessionId: "direct-id",
			sessionKey: "direct-key",
		}),
	).toMatchObject({ sessionId: "direct-id", sessionKey: "direct-key" });
});
