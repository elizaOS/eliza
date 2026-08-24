/**
 * Unit tests for shared test utils: validates saveEnv, envSnapshot,
 * withTimeout timeout handling, sleep delay, and createDeferred promises.
 */
import { describe, expect, it } from "vitest";
import {
	createDeferred,
	envSnapshot,
	saveEnv,
	sleep,
	withTimeout,
} from "./shared-test-utils.ts";

describe("shared-test-utils", () => {
	describe("saveEnv", () => {
		it("restores original environment variable state", () => {
			const testKey = "TEST_ENV_VAR_123";
			process.env[testKey] = "original";

			const env = saveEnv(testKey);
			process.env[testKey] = "modified";
			expect(process.env[testKey]).toBe("modified");

			env.restore();
			expect(process.env[testKey]).toBe("original");
			delete process.env[testKey];
		});
	});

	describe("envSnapshot", () => {
		it("supports set, clear, and restore", () => {
			const testKey = "SNAPSHOT_VAR_456";
			delete process.env[testKey];

			const snapshot = envSnapshot([testKey]);
			snapshot.set(testKey, "temporary");
			expect(process.env[testKey]).toBe("temporary");

			snapshot.clear();
			expect(process.env[testKey]).toBeUndefined();

			snapshot.restore();
			expect(process.env[testKey]).toBeUndefined();
		});
	});

	describe("withTimeout", () => {
		it("resolves when promise completes within duration", async () => {
			const res = await withTimeout(Promise.resolve("success"), 500);
			expect(res).toBe("success");
		});

		it("rejects when promise times out", async () => {
			const slowPromise = new Promise((resolve) => setTimeout(resolve, 200));
			await expect(withTimeout(slowPromise, 20, "SlowOp")).rejects.toThrow(
				"SlowOp timed out after 20ms",
			);
		});
	});

	describe("sleep", () => {
		it("resolves after delay", async () => {
			const start = Date.now();
			await sleep(20);
			expect(Date.now() - start).toBeGreaterThanOrEqual(15);
		});
	});

	describe("createDeferred", () => {
		it("creates a promise that can be resolved externally", async () => {
			const deferred = createDeferred<string>();
			deferred.resolve("resolved_value");
			const val = await deferred.promise;
			expect(val).toBe("resolved_value");
		});

		it("creates a promise that can be rejected externally", async () => {
			const deferred = createDeferred<string>();
			deferred.reject(new Error("rejected_error"));
			await expect(deferred.promise).rejects.toThrow("rejected_error");
		});
	});
});
