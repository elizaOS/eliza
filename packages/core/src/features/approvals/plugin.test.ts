import { describe, expect, test } from "vitest";
import { approvalsPlugin } from "./plugin";

describe("approvalsPlugin", () => {
	test("registers the five atomic approval actions", () => {
		expect(approvalsPlugin.name).toBe("approvals");
		const actionNames = (approvalsPlugin.actions ?? [])
			.map((a) => a.name)
			.sort();
		expect(actionNames).toEqual(
			[
				"AWAIT_APPROVAL",
				"BIND_IDENTITY_TO_SESSION",
				"DELIVER_APPROVAL_LINK",
				"REQUEST_IDENTITY_VERIFICATION",
				"VERIFY_APPROVAL_SIGNATURE",
			].sort(),
		);
	});

	test("does not register any services, providers, or evaluators", () => {
		expect(approvalsPlugin.services ?? []).toHaveLength(0);
		expect(approvalsPlugin.providers ?? []).toHaveLength(0);
		expect(approvalsPlugin.evaluators ?? []).toHaveLength(0);
	});
});
