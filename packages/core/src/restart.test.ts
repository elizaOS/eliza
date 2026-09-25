import { describe, expect, it, vi } from "vitest";

describe("host restart dispatch", () => {
	it("requires a handler and preserves its completion and failures", async () => {
		vi.resetModules();
		const { requestRestart, setRestartHandler } = await import("./restart.js");
		expect(() => requestRestart("startup")).toThrowError(
			expect.objectContaining({ code: "RESTART_HANDLER_NOT_INSTALLED" }),
		);
		let reason: string | undefined;
		const completion = Promise.resolve();
		setRestartHandler((value) => {
			reason = value;
			return completion;
		});
		expect(requestRestart("configuration changed")).toBe(completion);
		expect(reason).toBe("configuration changed");
		const failure = new Error("host restart failed");
		setRestartHandler(() => {
			throw failure;
		});
		expect(() => requestRestart()).toThrow(failure);
		setRestartHandler(() => Promise.reject(failure));
		await expect(requestRestart()).rejects.toBe(failure);
	});
});
