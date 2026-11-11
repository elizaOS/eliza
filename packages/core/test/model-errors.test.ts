import { describe, expect, it } from "vitest";
import { isProviderSchemaRejection } from "../src/utils/model-errors.ts";

const SCHEMA_MESSAGE = "failed to compile the JSON schema grammar";

describe("isProviderSchemaRejection", () => {
	it("detects a schema rejection wrapped under a 500 status", () => {
		expect(
			isProviderSchemaRejection({
				status: 500,
				message: "wrap",
				cause: {
					status: 400,
					code: "MODEL_PROVIDER_FAILED",
					message: SCHEMA_MESSAGE,
				},
			}),
		).toBe(true);
	});

	it("detects a direct 400 schema rejection", () => {
		expect(
			isProviderSchemaRejection({
				status: 400,
				code: "MODEL_PROVIDER_FAILED",
				message: SCHEMA_MESSAGE,
			}),
		).toBe(true);
	});

	it("does not treat a wrapped 400 non-schema error as a schema rejection", () => {
		expect(
			isProviderSchemaRejection({
				status: 500,
				message: "wrap",
				cause: { status: 400, message: "bad request: unknown field" },
			}),
		).toBe(false);
	});

	it("does not treat a bare 500 carrying the schema phrase as a rejection", () => {
		expect(
			isProviderSchemaRejection({ status: 500, message: SCHEMA_MESSAGE }),
		).toBe(false);
	});

	it("does not treat a 429 carrying the schema phrase as a rejection", () => {
		expect(
			isProviderSchemaRejection({
				status: 429,
				code: "MODEL_PROVIDER_FAILED",
				message: SCHEMA_MESSAGE,
			}),
		).toBe(false);
	});
});
