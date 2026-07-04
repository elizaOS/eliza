/**
 * The real-system {@link RuntimeProbe} backing {@link detectOpenXrRuntime}. Kept
 * apart from `openxr-runtime.ts` so that module stays pure (no node imports) and
 * unit-tests against fixtures, while production resolves the live machine here.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import {
	detectOpenXrRuntime,
	type OpenXrRuntimeStatus,
	type RuntimeProbe,
} from "./openxr-runtime.ts";

export function defaultRuntimeProbe(): RuntimeProbe {
	return {
		platform: () => platform(),
		env: (key) => process.env[key],
		homedir: () => homedir(),
		fileExists: (path) => {
			try {
				return existsSync(path);
			} catch {
				return false;
			}
		},
		readFile: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
		which: (cmd) => {
			const probe = platform() === "win32" ? "where" : "which";
			try {
				const out = execFileSync(probe, [cmd], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				});
				const first = out.split(/\r?\n/).find((l) => l.trim().length > 0);
				return first?.trim() || null;
			} catch {
				return null;
			}
		},
		regQuery: (key, value) => {
			if (platform() !== "win32") return null;
			try {
				const out = execFileSync("reg", ["query", key, "/v", value], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				});
				// Last whitespace-delimited token of the matching line is the data.
				const line = out.split(/\r?\n/).find((l) => l.includes(value));
				const token = line
					?.trim()
					.split(/\s{2,}|\t/)
					.pop();
				return token?.trim() || null;
			} catch {
				return null;
			}
		},
	};
}

/** Detect the OpenXR runtime on the live machine. */
export function detectOpenXrRuntimeNow(): OpenXrRuntimeStatus {
	return detectOpenXrRuntime(defaultRuntimeProbe());
}
