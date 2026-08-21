import { afterEach, describe, expect, it, vi } from "vitest";
import { appControlPlugin } from "./index.ts";
import { VerificationRoomBridgeService } from "./services/verification-room-bridge.ts";

describe("app-control verification bridge startup", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("eager-loads the asynchronous verdict bridge after plugin services register", async () => {
		vi.useFakeTimers();
		const getServiceLoadPromise = vi.fn(async () => undefined);
		const runtime = {
			registerPipelineHook: vi.fn(),
			getServiceLoadPromise,
			logger: { warn: vi.fn() },
		};

		await appControlPlugin.init?.({}, runtime as never);
		expect(getServiceLoadPromise).not.toHaveBeenCalled();

		await vi.runAllTimersAsync();
		expect(getServiceLoadPromise).toHaveBeenCalledTimes(1);
		expect(getServiceLoadPromise).toHaveBeenCalledWith(
			VerificationRoomBridgeService.serviceType,
		);
	});
});
