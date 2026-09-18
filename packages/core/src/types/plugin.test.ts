import { describe, expect, it } from "vitest";
import { collapseViewDeclarations, type ViewDeclaration } from "./plugin";
import type { IAgentRuntime } from "./runtime";

describe("ViewDeclaration server interactions", () => {
	it("preserves a runtime-aware handler when declarations are collapsed", async () => {
		const service = { owner: "runtime-owner" };
		const runtime = {
			getService: (serviceType: string) =>
				serviceType === "runtime-owned" ? service : null,
		} as IAgentRuntime;
		const view: ViewDeclaration = {
			id: "runtime-owned-view",
			label: "Runtime-owned view",
			serverInteract: async (_capability, _params, context) =>
				context?.runtime?.getService("runtime-owned"),
		};

		const [collapsed] = collapseViewDeclarations([view]);
		expect(collapsed.serverInteract).toBe(view.serverInteract);
		expect(
			await collapsed.serverInteract?.("read-owner", undefined, { runtime }),
		).toBe(service);
	});
});
