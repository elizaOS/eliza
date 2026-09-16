/** Canonical operation schemas for mediated trust and secret effects. */
import { describe, expect, it } from "vitest";
import { secretsAction } from "../../../../plugins/plugin-assistant/src/features/secrets/actions/manage-secret.ts";
import { trustAction } from "../../../../plugins/plugin-assistant/src/features/trust/actions/trust.ts";

describe("action discriminators", () => {
	it("TRUST umbrella uses canonical action discriminator with all subactions", () => {
		expect(trustAction.name).toBe("TRUST");
		const discriminator = (trustAction.parameters ?? []).find(
			(parameter) => parameter.name === "action",
		);
		expect(
			discriminator,
			"TRUST must declare an `action` parameter",
		).toBeDefined();
		const schema = discriminator?.schema as { enum?: string[] } | undefined;
		expect(schema?.enum).toBeDefined();
		expect(new Set(schema?.enum ?? [])).toEqual(
			new Set([
				"evaluate",
				"record_interaction",
				"request_elevation",
				"update_role",
			]),
		);
	});
	it("SECRETS umbrella uses canonical action discriminator with all subactions", () => {
		expect(secretsAction.name).toBe("SECRETS");
		const discriminator = (secretsAction.parameters ?? []).find(
			(parameter) => parameter.name === "action",
		);
		expect(
			discriminator,
			"SECRETS must declare an `action` parameter",
		).toBeDefined();
		const schema = discriminator?.schema as { enum?: string[] } | undefined;
		expect(schema?.enum).toBeDefined();
		expect(new Set(schema?.enum ?? [])).toEqual(
			new Set(["get", "set", "delete", "list", "check", "mirror", "request"]),
		);
	});
});
