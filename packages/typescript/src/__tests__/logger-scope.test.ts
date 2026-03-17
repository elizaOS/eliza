import { describe, expect, it } from "vitest";
import { loggerScope } from "../logger";

describe("Logger Scope", () => {
	it("should be defined", () => {
		expect(loggerScope).toBeDefined();
	});

	it("should allow running code within a scope", () => {
		const testContext = {
			runtime: {} as any, // Mock runtime
			roomId: "test-room-id",
			logLevel: "debug",
		};

		loggerScope.run(testContext, () => {
			const store = loggerScope.getStore();
			expect(store).toBeDefined();
			expect(store?.roomId).toBe("test-room-id");
			expect(store?.logLevel).toBe("debug");
		});
	});

	it("should not have store outside of run", () => {
		const store = loggerScope.getStore();
		expect(store).toBeUndefined();
	});

	it("should support nested scopes (though not strictly required, good to know)", () => {
		const outerContext = { roomId: "outer", runtime: {} as any };
		const innerContext = { roomId: "inner", runtime: {} as any };

		loggerScope.run(outerContext, () => {
			expect(loggerScope.getStore()?.roomId).toBe("outer");

			loggerScope.run(innerContext, () => {
				expect(loggerScope.getStore()?.roomId).toBe("inner");
			});

			expect(loggerScope.getStore()?.roomId).toBe("outer");
		});
	});
});

import { addLogListener, createLogger, type LogEntry } from "../logger";

describe("Functional Logger Scope", () => {
	it("should override log level via scope", async () => {
		// Create a custom logger to ensure we're starting clean or using the global one
		const testLogger = createLogger({ agentName: "test-scope" });

		const logs: LogEntry[] = [];
		const removeListener = addLogListener((entry) => {
			logs.push(entry);
		});

		try {
			// Default level is likely info, so debug should be ignored
			testLogger.debug("Should be ignored");

			// Wait a tick just in case (though it's sync)
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify no logs
			const debugLogs = logs.filter((l) => l.msg === "Should be ignored");
			expect(debugLogs.length).toBe(0);

			// Now run with scope override
			const scopeContext = {
				runtime: {} as any,
				roomId: "scope-room",
				logLevel: "debug",
			};

			await loggerScope.run(scopeContext, async () => {
				testLogger.debug("Should be visible");
				testLogger.info("Should also be visible");
			});

			// Verify logs
			const visibleDebugLogs = logs.filter(
				(l) => l.msg === "Should be visible",
			);
			expect(visibleDebugLogs.length).toBe(1);
			expect(visibleDebugLogs[0].roomId).toBe("scope-room");

			const visibleInfoLogs = logs.filter(
				(l) => l.msg === "Should also be visible",
			);
			expect(visibleInfoLogs.length).toBe(1);
			expect(visibleInfoLogs[0].roomId).toBe("scope-room");
		} finally {
			removeListener();
		}
	});
});
