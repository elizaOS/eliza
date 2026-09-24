/**
 * Dispatches Linux website navigation to full system Chromium in the user's
 * persistent browser profile. No embedded engine, header overrides, temporary
 * profile, or debugging port participates in this browser handoff.
 */
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { ElizaError } from "@elizaos/core";

export function validateSystemBrowserUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch (cause) {
		// error-policy:J3 Reject malformed navigation before process dispatch.
		throw new ElizaError("Enter a complete http or https website address.", {
			code: "INVALID_BROWSER_URL",
			cause,
		});
	}
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password
	) {
		throw new ElizaError(
			"Websites must use http or https without embedded credentials.",
			{
				code: "INVALID_BROWSER_URL",
			},
		);
	}
	return url.href;
}

export async function openSystemBrowser(options: { url: string }): Promise<{
	engine: "chromium";
	surface: "window";
}> {
	const url = validateSystemBrowserUrl(options.url);
	if (process.platform !== "linux") {
		throw new ElizaError("System Chromium handoff is available on Linux.", {
			code: "BROWSER_PLATFORM_UNSUPPORTED",
		});
	}
	let executable: string | undefined;
	for (const candidate of ["/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
		try {
			await access(candidate, constants.X_OK);
			executable = candidate;
			break;
		} catch (cause) {
			// error-policy:J4 Missing distribution-specific binaries are unavailable candidates.
			if (
				!(cause instanceof Error) ||
				!("code" in cause) ||
				(cause.code !== "ENOENT" && cause.code !== "EACCES")
			)
				throw cause;
		}
	}
	if (!executable) {
		throw new ElizaError(
			"Install or enable the system Chromium browser, then try again.",
			{
				code: "BROWSER_UNAVAILABLE",
			},
		);
	}
	await new Promise<void>((resolve, reject) => {
		const child = spawn(executable, ["--new-window", url], {
			detached: true,
			stdio: "ignore",
			shell: false,
		});
		child.once("error", (cause) =>
			reject(
				new ElizaError("Chromium could not start.", {
					code: "BROWSER_LAUNCH_FAILED",
					cause,
				}),
			),
		);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
	// A process dispatch receipt is not a claim that the requested website loaded.
	return { engine: "chromium", surface: "window" };
}
