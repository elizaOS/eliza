import { describe, expect, it } from "vitest";
import { modelProviderErrorDetail } from "../src/utils/model-errors";

describe("modelProviderErrorDetail provider message", () => {
	it("recovers the structured message from a wrapped cause when the outer body is plain text", () => {
		const error = new Error("Bad Request");
		(error as { responseBody?: string }).responseBody = "Bad Request";
		(error as { cause?: unknown }).cause = Object.assign(new Error("wrapped"), {
			status: 400,
			responseBody: JSON.stringify({
				message: "quota exceeded for model X",
			}),
		});
		const detail = modelProviderErrorDetail(error);
		expect(detail?.providerMessage).toBe("quota exceeded for model X");
		// The excerpt still comes from the first body found.
		expect(detail?.responseBodyExcerpt).toBe("Bad Request");
		expect(detail?.status).toBe(400);
	});

	it("still reads the message from the first body when it is structured", () => {
		const error = Object.assign(new Error("Bad Request"), {
			status: 400,
			responseBody: JSON.stringify({ message: "outer message" }),
		});
		expect(modelProviderErrorDetail(error)?.providerMessage).toBe(
			"outer message",
		);
	});

	it("still returns undefined when no node carries a status or a body", () => {
		expect(modelProviderErrorDetail(new Error("plain"))).toBeUndefined();
	});
});
