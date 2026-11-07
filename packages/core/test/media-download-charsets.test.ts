import { expect, it } from "vitest";
import { fetchRemoteMedia } from "../src/media/fetch.ts";

it.each([
	["attachment; filename*=ISO-8859-1''caf%E9.txt", "café.txt"],
	["attachment; filename*=iso-8859-1'en'%A3rates.txt", "£rates.txt"],
	["attachment; filename*=UTF-8''caf%C3%A9.txt", "café.txt"],
	["attachment; filename*=ISO-8859-1''..%2Fcaf%E9.txt", "café.txt"],
])("derives the safe filename from %s", async (header, expected) => {
	const result = await fetchRemoteMedia({
		url: "https://media.example.test/download",
		maxBytes: 100,
		fetchImpl: async () =>
			new Response("hello", {
				headers: {
					"content-type": "text/plain",
					"content-disposition": header,
				},
			}),
	});
	expect(result.fileName).toBe(expected);
	expect(result.buffer.toString()).toBe("hello");
});
