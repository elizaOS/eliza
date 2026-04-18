import { describe, expect, it } from "vitest";
import { extractPlannerActionNames } from "../services/message.ts";

describe("extractPlannerActionNames", () => {
	it("parses bare XML action entries without nested <name> tags", () => {
		expect(
			extractPlannerActionNames({
				actions:
					"<action>CALENDAR_ACTION</action><action>REQUEST_FIELD_FILL</action>",
			}),
		).toEqual(["CALENDAR_ACTION", "REQUEST_FIELD_FILL"]);
	});

	it("normalizes action arrays that still contain XML wrappers", () => {
		expect(
			extractPlannerActionNames({
				actions: ['<action>CALENDAR_ACTION</action>', '"REQUEST_FIELD_FILL"'],
			}),
		).toEqual(["CALENDAR_ACTION", "REQUEST_FIELD_FILL"]);
	});
});
