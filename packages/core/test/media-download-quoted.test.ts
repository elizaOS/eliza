import { expect, it } from "vitest";
import { fetchRemoteMedia } from "../src/media/fetch.ts";

it.each([
	['attachment; filename="report; final.txt"', "report; final.txt"],
	['attachment; filename="say\\"hello.txt"', 'say"hello.txt'],
	['attachment; filename="../report; final.txt"', "report; final.txt"],
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
