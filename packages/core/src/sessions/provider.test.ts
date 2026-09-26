import { expect, it } from "vitest";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import { createSessionProvider } from "./provider";

it("keeps metadata session deny guidance when a connector supplies empty direct IDs", async () => {
	const provider = createSessionProvider();
	const message = {
		sessionId: "",
		sessionKey: "",
		metadata: {
			session: { sessionId: "metadata-session", sendPolicy: "deny" },
		},
	} as unknown as Memory;
	const result = await provider.get({} as IAgentRuntime, message, {} as State);
	expect(result.text).toContain("Session ID: metadata-session");
	expect(result.text).toContain("SEND POLICY: DENY");
	const direct = await provider.get(
		{} as IAgentRuntime,
		{ ...message, sessionId: "direct-session" },
		{} as State,
	);
	expect(direct.text).toContain("Session ID: direct-session");
});
