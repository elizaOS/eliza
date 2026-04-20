import { describe, expect, it } from "vitest";
import {
	extractPlannerActionNames,
	normalizePlannerActions,
	normalizePlannerProviders,
} from "../services/message.ts";

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

	it("rejects malformed provider prose instead of tokenizing it as provider names", () => {
		expect(
			normalizePlannerProviders({
				providers:
					"Use inbox triage and then explain it to the user.\n<response>not-a-provider-list</response>",
			}),
		).toEqual([]);
	});

	it("keeps BOOK_TRAVEL unresolved instead of coercing it to CALL_EXTERNAL", () => {
		const runtime = {
			actions: [{ name: "CALL_EXTERNAL" }, { name: "CALENDAR_ACTION" }],
			isActionPlanningEnabled: () => true,
			logger: { info: () => undefined, warn: () => undefined },
		} as const;
		expect(
			normalizePlannerActions(
				{
				actions: "<action>BOOK_TRAVEL</action>",
				},
				runtime as never,
			),
		).toEqual(["IGNORE"]);
	});
});
