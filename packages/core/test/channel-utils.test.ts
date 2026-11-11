/** source and isLive describe the same fact: a live location's source is
 * "live". Today they are resolved independently, so one input produces two
 * answers: formatLocationText shows a live header while toLocationContext
 * reports LocationIsLive false (and vice versa for a live flag on a pin). */
import { describe, expect, it } from "vitest";
import {
	formatLocationText,
	toLocationContext,
	type NormalizedLocation,
} from "../src/utils/channel-utils";

const coords = { latitude: 1, longitude: 2 };

describe("location live/source agreement", () => {
	it("an explicitly non-live location is not shown as live", () => {
		const location: NormalizedLocation = {
			...coords,
			source: "live",
			isLive: false,
		};
		expect(formatLocationText(location)).toBe("📍 1.000000, 2.000000");
		const context = toLocationContext(location);
		expect(context.LocationIsLive).toBe(false);
		expect(context.LocationSource).toBe("pin");
	});

	it("an explicitly live location is shown as live even when its source says pin", () => {
		const location: NormalizedLocation = {
			...coords,
			source: "pin",
			isLive: true,
		};
		expect(formatLocationText(location)).toBe(
			"🛰 Live location: 1.000000, 2.000000",
		);
		const context = toLocationContext(location);
		expect(context.LocationIsLive).toBe(true);
		expect(context.LocationSource).toBe("live");
	});

	it("keeps the existing defaults", () => {
		expect(formatLocationText({ ...coords, source: "live" })).toContain(
			"Live location",
		);
		expect(formatLocationText({ ...coords, isLive: true })).toContain(
			"Live location",
		);
		expect(formatLocationText({ ...coords, name: "Home" })).toContain(
			"📍 Home",
		);
		expect(formatLocationText({ ...coords })).toBe("📍 1.000000, 2.000000");
	});
});
