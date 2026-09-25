/** Shutdown must prove the owned child exited before database recovery can proceed. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { AgentManager } from "./agent";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lifecycle-"));
beforeAll(() => {
	vi.spyOn(os, "homedir").mockReturnValue(directory);
});
afterAll(() => {
	vi.restoreAllMocks();
	fs.rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

function ownedChild(state: "running" | "error") {
	const manager = new AgentManager();
	const exit = Promise.withResolvers<number>();
	const child = {
		pid: 123456,
		exitCode: null as number | null,
		signalCode: null,
		exited: exit.promise,
		kill: vi.fn(),
	};
	const release = vi.fn();
	Object.assign(manager, {
		childProcess: child,
		status: {
			state,
			agentName: "test",
			port: 31337,
			startedAt: null,
			error: state === "error" ? "startup timed out" : null,
		},
		databaseStartupLock: { release },
	});
	const internals = manager as unknown as {
		childProcess: typeof child | null;
		monitorChildExit: (proc: typeof child) => void;
		autoRestartTimer: ReturnType<typeof setTimeout> | number | null;
	};
	internals.monitorChildExit(child);
	return {
		manager,
		child,
		release,
		internals,
		failExit: exit.reject,
		exit: () => {
			child.exitCode = 0;
			exit.resolve(0);
		},
	};
}

describe("owned agent shutdown", () => {
	it("stops an errored child and retains the database lock until confirmed exit", async () => {
		const f = ownedChild("error");
		const stopped = f.manager.stop();
		expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(f.release).not.toHaveBeenCalled();
		expect(f.internals.childProcess).toBe(f.child);
		f.exit();
		await stopped;
		expect(f.release).toHaveBeenCalledOnce();
		expect(f.manager.getStatus().state).toBe("stopped");
	});

	it("rejects unconfirmed termination without discarding child or database ownership", async () => {
		const f = ownedChild("running");
		const result = f.manager.stop().then(
			() => null,
			(error) => error,
		);
		await vi.advanceTimersByTimeAsync(6000);
		expect(await result).toMatchObject({
			code: "AGENT_TERMINATION_UNCONFIRMED",
		});
		expect(f.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
		expect(f.internals.childProcess).toBe(f.child);
		expect(f.release).not.toHaveBeenCalled();
		f.exit();
		await f.manager.stop();
		expect(f.release).toHaveBeenCalledOnce();
	});

	it("shares concurrent shutdown and does not schedule a crash restart for deliberate exit", async () => {
		const f = ownedChild("running");
		const first = f.manager.stop();
		const second = f.manager.stop();
		expect(f.release).not.toHaveBeenCalled();
		f.exit();
		await Promise.all([first, second]);
		expect(f.child.kill).toHaveBeenCalledTimes(1);
		expect(f.internals.autoRestartTimer).toBeNull();
		expect(f.release).toHaveBeenCalledOnce();
	});

	it("keeps ownership when the process exit observer rejects", async () => {
		const f = ownedChild("running");
		f.failExit(new Error("exit observation failed"));
		await Promise.resolve();
		await Promise.resolve();
		expect(f.internals.childProcess).toBe(f.child);
		expect(f.release).not.toHaveBeenCalled();
		expect(f.internals.autoRestartTimer).toBeNull();
		await expect(f.manager.stop()).rejects.toThrow("exit observation failed");
		expect(f.release).not.toHaveBeenCalled();
	});

	it("cancels a pending crash restart when disposed", async () => {
		const f = ownedChild("error");
		f.exit();
		await Promise.resolve();
		const restart = vi.fn();
		f.internals.autoRestartTimer = setTimeout(restart, 1000);
		await f.manager.dispose();
		await vi.advanceTimersByTimeAsync(1000);
		expect(restart).not.toHaveBeenCalled();
	});
});
