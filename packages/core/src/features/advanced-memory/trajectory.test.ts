/**
 * Behavior tests for logAdvancedMemoryTrajectory — the advanced-memory
 * providers' telemetry bridge into the trajectory recorder.
 *
 * Covers the step-id resolution chain (message metadata first, ambient
 * trajectory context second), the no-op paths (no step id, no logger
 * service, logger without the expected method), the passthrough payload,
 * and the J7 error policy: a failing logger is reported through
 * runtime.reportError and never propagates into the message path.
 */
import { describe, expect, it, vi } from "vitest";

const { getTrajectoryContext } = await import("../../trajectory-context.ts");
const { logAdvancedMemoryTrajectory } = await import("./trajectory.ts");

vi.mock("../../trajectory-context.ts", () => ({
	getTrajectoryContext: vi.fn(),
}));

function makeRuntime(logger?: {
	logProviderAccess?: (params: unknown) => void;
}) {
	const reportError = vi.fn();
	return {
		runtime: {
			getService: vi.fn().mockReturnValue(logger ?? null),
			reportError,
		},
		reportError,
	};
}

function makeMessage(trajectoryStepId?: string) {
	if (trajectoryStepId === undefined) return undefined;
	return {
		metadata: { trajectoryStepId },
	} as never;
}

describe("logAdvancedMemoryTrajectory", () => {
	it("no-ops when neither message metadata nor ambient context has a step id", () => {
		vi.mocked(getTrajectoryContext).mockReturnValue(undefined);
		const { runtime, reportError } = makeRuntime({
			logProviderAccess: vi.fn(),
		});
		logAdvancedMemoryTrajectory({
			runtime,
			message: makeMessage(),
			providerName: "long-term-memory",
			purpose: "provider-access",
			data: { query: "x" },
		});
		expect(runtime.getService).not.toHaveBeenCalled();
		expect(reportError).not.toHaveBeenCalled();
	});

	it("uses the trimmed message metadata step id and forwards the full payload", () => {
		vi.mocked(getTrajectoryContext).mockReturnValue(undefined);
		const logProviderAccess = vi.fn();
		const { runtime } = makeRuntime({ logProviderAccess });
		logAdvancedMemoryTrajectory({
			runtime,
			message: makeMessage("  step-42  "),
			providerName: "context-summary",
			purpose: "provider-access",
			data: { scope: "global" },
			query: { q: "hello" },
		});
		expect(logProviderAccess).toHaveBeenCalledTimes(1);
		expect(logProviderAccess).toHaveBeenCalledWith({
			stepId: "step-42",
			providerName: "context-summary",
			purpose: "provider-access",
			data: { scope: "global" },
			query: { q: "hello" },
		});
	});

	it("falls back to the ambient trajectory context when the message has no step id", () => {
		vi.mocked(getTrajectoryContext).mockReturnValue({
			trajectoryStepId: "ctx-step",
		} as never);
		const logProviderAccess = vi.fn();
		const { runtime } = makeRuntime({ logProviderAccess });
		logAdvancedMemoryTrajectory({
			runtime,
			message: makeMessage(),
			providerName: "long-term-memory",
			purpose: "provider-access",
			data: {},
		});
		expect(logProviderAccess).toHaveBeenCalledWith(
			expect.objectContaining({ stepId: "ctx-step" }),
		);
	});

	it("prefers message metadata over ambient context", () => {
		vi.mocked(getTrajectoryContext).mockReturnValue({
			trajectoryStepId: "ctx-step",
		} as never);
		const logProviderAccess = vi.fn();
		const { runtime } = makeRuntime({ logProviderAccess });
		logAdvancedMemoryTrajectory({
			runtime,
			message: makeMessage("msg-step"),
			providerName: "long-term-memory",
			purpose: "provider-access",
			data: {},
		});
		expect(logProviderAccess).toHaveBeenCalledWith(
			expect.objectContaining({ stepId: "msg-step" }),
		);
	});

	it("no-ops when the trajectories service is absent", () => {
		vi.mocked(getTrajectoryContext).mockReturnValue({
			trajectoryStepId: "step-1",
		} as never);
		const { runtime, reportError } = makeRuntime(null);
		logAdvancedMemoryTrajectory({
			runtime,
			providerName: "long-term-memory",
			purpose: "provider-access",
			data: {},
		});
		expect(reportError).not.toHaveBeenCalled();
	});

	it("no-ops when the trajectories service lacks logProviderAccess", () => {
		vi.mocked(getTrajectoryContext).mockReturnValue({
			trajectoryStepId: "step-1",
		} as never);
		const { runtime, reportError } = makeRuntime({});
		logAdvancedMemoryTrajectory({
			runtime,
			providerName: "long-term-memory",
			purpose: "provider-access",
			data: {},
		});
		expect(reportError).not.toHaveBeenCalled();
	});

	it("reports a failing logger through reportError instead of throwing (J7)", () => {
		vi.mocked(getTrajectoryContext).mockReturnValue({
			trajectoryStepId: "step-1",
		} as never);
		const boom = new Error("telemetry backend down");
		const { runtime, reportError } = makeRuntime({
			logProviderAccess: vi.fn().mockImplementation(() => {
				throw boom;
			}),
		});
		expect(() =>
			logAdvancedMemoryTrajectory({
				runtime,
				providerName: "long-term-memory",
				purpose: "provider-access",
				data: {},
			}),
		).not.toThrow();
		expect(reportError).toHaveBeenCalledWith(
			"AdvancedMemory.trajectoryProviderAccess",
			boom,
			{ providerName: "long-term-memory" },
		);
	});
});
