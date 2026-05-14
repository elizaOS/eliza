import { describe, expect, test } from "vitest";
import { oauthPlugin } from "./plugin";

describe("oauthPlugin", () => {
	test("registers the five atomic OAuth actions", () => {
		expect(oauthPlugin.name).toBe("oauth");
		const actionNames = (oauthPlugin.actions ?? []).map((a) => a.name).sort();
		expect(actionNames).toEqual(
			[
				"AWAIT_OAUTH_CALLBACK",
				"BIND_OAUTH_CREDENTIAL",
				"CREATE_OAUTH_INTENT",
				"DELIVER_OAUTH_LINK",
				"REVOKE_OAUTH_CREDENTIAL",
			].sort(),
		);
	});

	test("does not register any services, providers, or evaluators", () => {
		expect(oauthPlugin.services ?? []).toHaveLength(0);
		expect(oauthPlugin.providers ?? []).toHaveLength(0);
		expect(oauthPlugin.evaluators ?? []).toHaveLength(0);
	});
});
