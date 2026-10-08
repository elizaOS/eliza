import { describe, expect, it } from "vitest";
import { parseMeetingUrl } from "../src/meetings.ts";

const MEET = "https://meet.google.com/abc-defg-hij";

describe("parseMeetingUrl", () => {
	it("accepts a trailing slash on a Google Meet link", () => {
		expect(parseMeetingUrl(`${MEET}/`)?.nativeMeetingId).toBe("abc-defg-hij");
		expect(parseMeetingUrl(`${MEET}/`)?.meetingUrl).toBe(MEET);
		expect(parseMeetingUrl(`${MEET}/?authuser=0`)?.meetingUrl).toBe(MEET);
		expect(parseMeetingUrl(`${MEET}/extra`)).toBeNull();
		expect(parseMeetingUrl(MEET)?.meetingUrl).toBe(MEET);
	});
});
