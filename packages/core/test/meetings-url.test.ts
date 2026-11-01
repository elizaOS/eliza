import { describe, expect, it } from "vitest";
import { parseMeetingUrl } from "../src/meetings";

describe("parseMeetingUrl Zoom links", () => {
	// Zoom's launch page rewrites the address bar to /j/<id>#success once it
	// has opened the app, so a link copied from the browser carries it.
	it("accepts a join link that ends in the launch page's #success", () => {
		expect(
			parseMeetingUrl("https://us02web.zoom.us/j/84512339087#success"),
		).toEqual({
			platform: "zoom",
			meetingUrl: "https://app.zoom.us/wc/84512339087/join",
			nativeMeetingId: "84512339087",
		});
	});

	it("keeps the passcode and drops the fragment from the canonical link", () => {
		expect(
			parseMeetingUrl(
				"https://us02web.zoom.us/j/84512339087?pwd=Pass9#success",
			),
		).toEqual({
			platform: "zoom",
			meetingUrl: "https://app.zoom.us/wc/84512339087/join?pwd=Pass9",
			nativeMeetingId: "84512339087",
		});
	});

	it("still rejects a longer number after the id", () => {
		expect(
			parseMeetingUrl("https://zoom.us/j/8451233908712345#success"),
		).toBeNull();
	});
});
