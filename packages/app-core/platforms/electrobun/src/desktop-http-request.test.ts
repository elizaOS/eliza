import { afterEach, describe, expect, it, vi } from "vitest";
import {
	desktopHttpRequest,
	normalizeDesktopHttpRequest,
} from "./desktop-http-request";

describe("desktopHttpRequest", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("allows external plain HTTP requests", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response("ok", {
				status: 201,
				statusText: "Created",
				headers: { "content-type": "text/plain" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			desktopHttpRequest({
				url: "http://agent.example:2138/api/auth/status",
				method: "POST",
				headers: { authorization: "Bearer token" },
				body: "{}",
				timeoutMs: 5000,
			}),
		).resolves.toEqual({
			status: 201,
			statusText: "Created",
			headers: { "content-type": "text/plain" },
			body: "ok",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"http://agent.example:2138/api/auth/status",
			expect.objectContaining({
				method: "POST",
				headers: { authorization: "Bearer token" },
				body: "{}",
			}),
		);
	});

	it("rejects non-external or non-plain-HTTP targets in the main process", () => {
		for (const url of [
			"http://127.0.0.1:2138",
			"http://localhost:2138",
			"http://[::1]:2138",
			"http://0.0.0.0:2138",
			"https://agent.example:2138",
		]) {
			expect(() => normalizeDesktopHttpRequest({ url })).toThrow(
				"external plain HTTP",
			);
		}
	});

	it("times out the full request including response body reads", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				status: 200,
				statusText: "OK",
				headers: new Headers(),
				text: () => new Promise<string>(() => {}),
			}),
		);

		const request = desktopHttpRequest({
			url: "http://agent.example:2138/api/chat",
			timeoutMs: 1000,
		});
		const assertion = expect(request).rejects.toThrow(
			"desktopHttpRequest timed out after 1000ms.",
		);
		await vi.advanceTimersByTimeAsync(1000);

		await assertion;
	});
});
