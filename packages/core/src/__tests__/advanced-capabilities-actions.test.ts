import { describe, expect, it } from "vitest";
import { advancedActions } from "../features/advanced-capabilities/index.ts";

describe("advancedActions", () => {
	it("exposes SAVE_ATTACHMENT_TO_CLIPBOARD as a selectable advanced action", () => {
		expect(advancedActions.map((action) => action.name)).toContain(
			"SAVE_ATTACHMENT_TO_CLIPBOARD",
		);
	});
});
