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

describe("extractPlannerProviderNames", () => {
	it("parses structured provider lists and rejects prose fallback junk", () => {
		expect(
			extractPlannerProviderNames({
				providers: "CURRENT_TIME, ATTACHMENTS",
			}),
		).toEqual(["CURRENT_TIME", "ATTACHMENTS"]);
		expect(
			extractPlannerProviderNames({
				providers:
					"Use CURRENT_TIME and maybe ATTACHMENTS if needed for this reply.",
			}),
		).toEqual([]);
	});

		it("parses XML provider tags but ignores malformed XML prose", () => {
			expect(
				extractPlannerProviderNames({
					providers:
						"<provider>CURRENT_TIME</provider><provider>ATTACHMENTS</provider>",
			}),
		).toEqual(["CURRENT_TIME", "ATTACHMENTS"]);
			expect(
				extractPlannerProviderNames({
					providers:
						"<providers>I think CURRENT_TIME would help here</providers>",
				}),
			).toEqual([]);
		});

		it("flattens JSON-like provider entries embedded inside provider arrays", () => {
			expect(
				extractPlannerProviderNames({
					providers: ['["AVAILABLE_DOCUMENTS"]', "CURRENT_TIME"],
				}),
			).toEqual(["AVAILABLE_DOCUMENTS", "CURRENT_TIME"]);
		});
	});

describe("resolvePlannerActionName", () => {
	it("repairs observed calendar-planning aliases into registered actions", () => {
			const runtime = {
				actions: [
					{ name: "OWNER_CALENDAR" },
					{ name: "OWNER_INBOX" },
					{ name: "UPDATE_OWNER_PROFILE" },
					{ name: "PUBLISH_DEVICE_INTENT" },
					{ name: "LIFEOPS_COMPUTER_USE" },
					{ name: "BOOK_TRAVEL" },
				{ name: "CALL_EXTERNAL" },
			],
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
			},
		} as Parameters<typeof resolvePlannerActionName>[0];
		const actionLookup = new Map(
			runtime.actions.map((action) => [action.name.replace(/_/g, ""), action]),
		);

		expect(
			resolvePlannerActionName(runtime, actionLookup, "BULK_RESCHEDULE"),
		).toEqual(["OWNER_CALENDAR"]);
		expect(
			resolvePlannerActionName(runtime, actionLookup, "GET_AVAILABILITY"),
		).toEqual(["OWNER_CALENDAR"]);
		expect(
			resolvePlannerActionName(
				runtime,
				actionLookup,
				"CREATE_TRAVEL_PREFERENCES",
			),
		).toEqual(["UPDATE_OWNER_PROFILE"]);
		expect(
			resolvePlannerActionName(
				runtime,
				actionLookup,
				"HANDLE_CANCELLATION_FEE",
			),
		).toEqual(["PUBLISH_DEVICE_INTENT"]);
		expect(
			resolvePlannerActionName(
				runtime,
				actionLookup,
				"SET_MULTI_DEVICE_REMINDER",
			),
		).toEqual(["PUBLISH_DEVICE_INTENT"]);
			expect(resolvePlannerActionName(runtime, actionLookup, "UPLOAD_PORTAL")).toEqual(
				["LIFEOPS_COMPUTER_USE"],
			);
			expect(
				resolvePlannerActionName(
					runtime,
					actionLookup,
					"FLIGHT_CONFLICT_REBOOKING",
				),
			).toEqual(["OWNER_CALENDAR"]);
			expect(
				resolvePlannerActionName(runtime, actionLookup, "EVENT_ASSET_CHECKLIST"),
			).toEqual(["OWNER_INBOX"]);
			expect(
				resolvePlannerActionName(
					runtime,
					actionLookup,
					"REQUEST_UPDATED_ID_COPY",
				),
			).toEqual(["PUBLISH_DEVICE_INTENT"]);
			expect(resolvePlannerActionName(runtime, actionLookup, "BOOK_TRAVEL")).toEqual(
				["BOOK_TRAVEL"],
			);
		});
	});
