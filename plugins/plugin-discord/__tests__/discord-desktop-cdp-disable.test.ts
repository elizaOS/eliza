import { execFile, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getDiscordDesktopCdpStatus,
	relaunchDiscordDesktopForCdp,
} from "../user-account-scraper/discord-desktop-cdp";

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

	it("reports CDP unavailable when its target inventory cannot be read", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/json/version")) {
				return Response.json({
					Browser: "Chrome/fixture",
					webSocketDebuggerUrl: "ws://127.0.0.1:9224/devtools/browser/fixture",
				});
			}
			return new Response("unavailable", { status: 503 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const status = await getDiscordDesktopCdpStatus({
			ELIZA_DISCORD_DESKTOP_CDP_PORT: "9224",
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(status.cdpAvailable).toBe(false);
		expect(status.lastError).toBe("HTTP 503");
	});
});
