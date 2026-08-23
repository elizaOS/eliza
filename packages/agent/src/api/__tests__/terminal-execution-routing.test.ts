import { describe, expect, it, vi } from "vitest";

vi.mock("./runtime/local-execution-mode.ts", () => ({
	shouldUseSandboxExecution: vi.fn(),
}));
vi.mock("@elizaos/core", () => ({
	logger: { error: vi.fn() },
}));

import { shouldUseSandboxExecution } from "./runtime/local-execution-mode.ts";
import {
	resolveTerminalExecutionRoute,
	toSandboxWorkdir,
} from "./terminal-execution-routing.ts";

describe("resolveTerminalExecutionRoute", () => {
	it("routes to host when sandbox mode is off", () => {
		(shouldUseSandboxExecution as ReturnType<typeof vi.fn>).mockReturnValue(
			false,
		);
		const route = resolveTerminalExecutionRoute({ sandboxManager: null });
		expect(route.route).toBe("host");
		expect(route.sandboxManager).toBeNull();
	});

	it("routes to sandbox when manager is available", () => {
		(shouldUseSandboxExecution as ReturnType<typeof vi.fn>).mockReturnValue(
			true,
		);
		const manager = {} as never;
		const route = resolveTerminalExecutionRoute({ sandboxManager: manager });
		expect(route.route).toBe("sandbox");
		expect(route.sandboxManager).toBe(manager);
	});

	it("fails closed without a manager in sandbox mode", () => {
		(shouldUseSandboxExecution as ReturnType<typeof vi.fn>).mockReturnValue(
			true,
		);
		const route = resolveTerminalExecutionRoute({ sandboxManager: null });
		expect(route.route).toBe("sandbox");
		expect(route.error).toContain("local-safe mode requires SandboxManager");
	});
});

describe("toSandboxWorkdir", () => {
	it("maps cwd to /workspace", () => {
		expect(toSandboxWorkdir(process.cwd())).toBe("/workspace");
	});

	it("maps subdirectories under /workspace", () => {
		const sub = `${process.cwd()}/sub/dir`;
		expect(toSandboxWorkdir(sub)).toBe("/workspace/sub/dir");
	});

	it("returns undefined for paths outside cwd", () => {
		expect(toSandboxWorkdir("/etc")).toBeUndefined();
	});
});
