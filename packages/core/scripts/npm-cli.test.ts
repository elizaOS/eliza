/** Deterministic unit coverage validates Core's platform-specific npm CLI resolution. */
import { describe, expect, it } from "vitest";
import { resolveNpmCliInvocation } from "./npm-cli";

function windowsInstallation(root: string): Set<string> {
	return new Set([
		`${root}\\node.exe`,
		`${root}\\npm.cmd`,
		`${root}\\node_modules\\npm\\bin\\npm-cli.js`,
	]);
}

describe("resolveNpmCliInvocation", () => {
	it("runs a discovered POSIX npm script through Node", () => {
		const files = new Set(["/opt/node/bin/node", "/home/user/bin/npm"]);

		expect(
			resolveNpmCliInvocation(["pack", "package path"], {
				platform: "linux",
				pathValue: ':/home/user/bin:"/opt/node/bin":/missing',
				fileExists: (filePath) => files.has(filePath),
			}),
		).toEqual({
			command: "/opt/node/bin/node",
			args: ["/home/user/bin/npm", "pack", "package path"],
		});
	});

	it("falls back to direct npm when POSIX PATH is incomplete", () => {
		expect(
			resolveNpmCliInvocation(["pack"], {
				platform: "darwin",
				pathValue: "/missing:/also-missing",
				fileExists: () => false,
			}),
		).toEqual({ command: "npm", args: ["pack"] });
	});

	it("uses node.exe plus npm-cli.js from a complete quoted PATH entry", () => {
		const root = "C:\\Program Files\\nodejs";
		const files = windowsInstallation(root);
		const args = ["pack", "C:\\repo with spaces", "--json"];

		expect(
			resolveNpmCliInvocation(args, {
				platform: "win32",
				pathValue: `;"${root}";C:\\other`,
				fileExists: (filePath) => files.has(filePath),
			}),
		).toEqual({
			command: `${root}\\node.exe`,
			args: [`${root}\\node_modules\\npm\\bin\\npm-cli.js`, ...args],
		});
	});

	it("skips incomplete installs and selects the first complete one", () => {
		const incomplete = "C:\\incomplete";
		const complete = "D:\\node";
		const files = windowsInstallation(complete);
		files.add(`${incomplete}\\node.exe`);
		files.add(`${incomplete}\\npm.cmd`);

		expect(
			resolveNpmCliInvocation(["--version"], {
				platform: "win32",
				pathValue: `${incomplete};${complete}`,
				fileExists: (filePath) => files.has(filePath),
			}),
		).toEqual({
			command: `${complete}\\node.exe`,
			args: [`${complete}\\node_modules\\npm\\bin\\npm-cli.js`, "--version"],
		});
	});

	it("falls back predictably when PATH has no complete npm installation", () => {
		expect(
			resolveNpmCliInvocation(["pack"], {
				platform: "win32",
				pathValue: ';"";C:\\missing',
				fileExists: () => false,
			}),
		).toEqual({ command: "npm", args: ["pack"] });
	});
});
