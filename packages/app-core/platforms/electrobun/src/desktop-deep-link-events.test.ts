import { describe, expect, it } from "vitest";
import { readOpenUrlEventUrl } from "./desktop-deep-link-events";

describe("desktop deep-link events", () => {
	it("accepts direct open-url string payloads", () => {
		expect(readOpenUrlEventUrl(" elizaos://assistant?text=hello ")).toBe(
			"elizaos://assistant?text=hello",
		);
	});

	it("accepts object open-url payloads from desktop event bridges", () => {
		expect(
			readOpenUrlEventUrl({
				url: "elizaos://assistant?source=macos-shortcuts",
			}),
		).toBe("elizaos://assistant?source=macos-shortcuts");
		expect(
			readOpenUrlEventUrl({
				data: { url: "elizaos://assistant?action=lifeops.create" },
			}),
		).toBe("elizaos://assistant?action=lifeops.create");
	});

	it("rejects empty or malformed open-url events", () => {
		expect(readOpenUrlEventUrl(" ")).toBeNull();
		expect(readOpenUrlEventUrl({ url: "" })).toBeNull();
		expect(readOpenUrlEventUrl({ data: { url: 42 } })).toBeNull();
		expect(readOpenUrlEventUrl(null)).toBeNull();
	});
});
