import { describe, expect, it } from "vitest";
import { activityEventToPlaintext } from "./activity-plaintext.ts";

function runEnd(durationMs: number): string | undefined {
	return activityEventToPlaintext({
		stream: "lifecycle",
		payload: { type: "run_end", success: true, durationMs },
	})?.plaintext;
}

describe("activity duration text", () => {
	it("does not print a 60 second remainder", () => {
		// 119.6s rounds the leftover seconds to 60, so the rail showed "1m 60s".
		expect(runEnd(119_600)).toBe("Run completed (2m 0s)");
		// 59.5s is still under a minute, but toFixed(0) printed "60s".
		expect(runEnd(59_500)).toBe("Run completed (1m 0s)");
		expect(runEnd(45_000)).toBe("Run completed (45s)");
		expect(runEnd(150_000)).toBe("Run completed (2m 30s)");
	});
});
