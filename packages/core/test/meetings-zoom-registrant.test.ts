import { describe, expect, it } from "vitest";
import { parseMeetingUrl, stripZoomRegistrantToken } from "../src/meetings";

describe("parseMeetingUrl Zoom registrant links", () => {
	// A meeting or webinar that requires registration admits a registrant
	// through the join link Zoom sends them, which carries a tk token.
	it("keeps the registrant token of a webinar join link", () => {
		expect(
			parseMeetingUrl(
				"https://us02web.zoom.us/w/84512339087?tk=Ab3-x_Yz.DQMAAAAUq9Pc0hY&pwd=Pass9",
			),
		).toEqual({
			platform: "zoom",
			meetingUrl:
				"https://app.zoom.us/wc/84512339087/join?pwd=Pass9&tk=Ab3-x_Yz.DQMAAAAUq9Pc0hY",
			nativeMeetingId: "84512339087",
		});
	});

	it("keeps the registrant token of a meeting link without a passcode", () => {
		expect(
			parseMeetingUrl(
				"https://zoom.us/j/84512339087?tk=Ab3-x_Yz.DQMAAAAUq9Pc0hY",
			),
		).toEqual({
			platform: "zoom",
			meetingUrl:
				"https://app.zoom.us/wc/84512339087/join?tk=Ab3-x_Yz.DQMAAAAUq9Pc0hY",
			nativeMeetingId: "84512339087",
		});
	});

	it("still keeps only the passcode of a link without a registrant token", () => {
		expect(
			parseMeetingUrl(
				"https://us02web.zoom.us/j/84512339087?pwd=Pass9&from=addon",
			),
		).toEqual({
			platform: "zoom",
			meetingUrl: "https://app.zoom.us/wc/84512339087/join?pwd=Pass9",
			nativeMeetingId: "84512339087",
		});
	});
});

describe("stripZoomRegistrantToken", () => {
	// The bot navigates with the token; what is stored, listed or logged is
	// the canonical link of the same meeting without it.
	it("drops only the registrant token from a Zoom join URL", () => {
		const withToken = parseMeetingUrl(
			"https://zoom.us/j/84512339087?pwd=Pa%2Bss&tk=Ab3-x_Yz.DQMAAAAUq9Pc0hY",
		);
		const withoutToken = parseMeetingUrl(
			"https://zoom.us/j/84512339087?pwd=Pa%2Bss",
		);
		expect(stripZoomRegistrantToken(withToken?.meetingUrl ?? "")).toBe(
			withoutToken?.meetingUrl,
		);
		expect(
			stripZoomRegistrantToken(
				"https://app.zoom.us/wc/84512339087/join?tk=Ab3-x_Yz.DQMAAAAUq9Pc0hY",
			),
		).toBe("https://app.zoom.us/wc/84512339087/join");
	});

	it("leaves links without a Zoom registrant token unchanged", () => {
		for (const url of [
			"https://app.zoom.us/wc/84512339087/join?pwd=Pass9",
			"https://app.zoom.us/wc/84512339087/join",
			"https://meet.google.com/abc-defg-hij?tk=not-zoom",
		]) {
			expect(stripZoomRegistrantToken(url)).toBe(url);
		}
	});
});
