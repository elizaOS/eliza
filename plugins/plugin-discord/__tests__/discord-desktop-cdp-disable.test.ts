import { execFile, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { relaunchDiscordDesktopForCdp } from "../user-account-scraper/discord-desktop-cdp";

vi.mock("node:child_process", () => ({
	execFile: vi.fn((...args: unknown[]) => {
		const callback = args[3] as (
			error: Error | null,
			stdout: string,
			stderr: string,
		) => void;
		callback(new Error("Discord process probe should not run"), "", "");
	}),
	spawn: vi.fn(),
}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("Discord Desktop CDP disable setting", () => {
	it.each(["1", "true"])(
		"does not probe or relaunch Discord when disabled with %s",
		async (disableValue) => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);

			const status = await relaunchDiscordDesktopForCdp({
				ELIZA_DISABLE_DISCORD_DESKTOP_CDP: disableValue,
			});

			expect(status.lastError).toBe(
				"Discord Desktop CDP disabled by environment.",
			);
			expect(execFile).not.toHaveBeenCalled();
			expect(spawn).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);
});
