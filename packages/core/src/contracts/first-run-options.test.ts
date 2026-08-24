/**
 * Canonical service-routing resolution ensures an explicit capability matrix
 * cannot gain ownership from unrelated ambient provider credentials.
 */
import { describe, expect, it } from "vitest";
import {
	inferFirstRunConnectionFromConfig,
	resolveServiceRoutingInConfig,
} from "./first-run-options.ts";

describe("resolveServiceRoutingInConfig canonical ownership", () => {
	it("does not infer llmText from ambient credentials beside a media-only route", () => {
		const config = {
			serviceRouting: {
				media: { backend: "elizacloud", transport: "cloud-proxy" },
			},
			env: { OPENAI_API_KEY: "sk-unrelated" },
		};
		const routing = resolveServiceRoutingInConfig(config);

		expect(routing).toEqual({
			media: { backend: "elizacloud", transport: "cloud-proxy" },
		});
		expect(routing?.llmText).toBeUndefined();
		expect(inferFirstRunConnectionFromConfig(config)).toBeNull();
	});
});
