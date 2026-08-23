/**
 * Exercises `validateMcpServerConfig`, the GHSA-54rx-pcr9-hg9x gate shared by
 * the agent API and the MCP spawn path: config-type and command allowlists,
 * per-family argument denylists (interpreters, package runners, containers,
 * deno), SSRF guards on remote URLs, env-injection rejection, and scalar field
 * validation. Deterministic: every case short-circuits before DNS, so the
 * suite never touches the network.
 */

import { describe, expect, test } from "vitest";
import { validateMcpServerConfig } from "./mcp-server-config";

describe("validateMcpServerConfig", () => {
	test("rejects a missing config type with the allowlist message", async () => {
		expect(await validateMcpServerConfig({})).toBe(
			"Invalid config type. Must be one of: stdio, http, streamable-http, sse",
		);
	});

	test.each([["websocket"], [42], [null], [undefined]])(
		"rejects config type %p",
		async (configType) => {
			expect(await validateMcpServerConfig({ type: configType })).toBe(
				"Invalid config type. Must be one of: stdio, http, streamable-http, sse",
			);
		},
	);

	test.each(["http", "streamable-http", "sse"])(
		"requires a URL for remote transport %s",
		async (type) => {
			expect(await validateMcpServerConfig({ type })).toBe(
				"URL is required for remote servers",
			);
			expect(await validateMcpServerConfig({ type, url: "   " })).toBe(
				"URL is required for remote servers",
			);
		},
	);

	describe("stdio command gating", () => {
		test("requires a command for stdio servers", async () => {
			expect(await validateMcpServerConfig({ type: "stdio" })).toBe(
				"Command is required for stdio servers",
			);
		});

		test("treats a whitespace-only command as missing", async () => {
			expect(
				await validateMcpServerConfig({ type: "stdio", command: "   " }),
			).toBe("Command is required for stdio servers");
		});

		test.each(["/usr/bin/node", "..\\node.exe", "a b"])(
			"rejects command %p that is not a bare executable name",
			async (command) => {
				expect(await validateMcpServerConfig({ type: "stdio", command })).toBe(
					"Command must be a bare executable name without path separators",
				);
			},
		);

		test("rejects an unlisted command and lists the allowed commands", async () => {
			expect(
				await validateMcpServerConfig({ type: "stdio", command: "curl" }),
			).toBe(
				'Command "curl" is not allowed. Allowed commands: npx, node, bun, bunx, deno, python, python3, uvx, uv, docker, podman',
			);
		});

		test("normalizes case and Windows executable suffixes before allowlisting", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "BUNX.EXE",
				}),
			).toBeNull();
		});
	});

	describe("interpreter argument denylist", () => {
		test("blocks -e for node", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "node",
					args: ["-e", "process.exit(1)"],
				}),
			).toBe('Flag "-e" is not allowed for node MCP servers');
		});

		test("blocks --eval for bun", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "bun",
					args: ["--eval", "1"],
				}),
			).toBe('Flag "--eval" is not allowed for bun MCP servers');
		});

		test("blocks a combined single-token interpreter flag like -eVALUE", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "node",
					args: ["-econsole.log(1)"],
				}),
			).toBe('Flag "-e" is not allowed for node MCP servers');
		});

		test("blocks --import for python3", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "python3",
					args: ["--import", "os"],
				}),
			).toBe('Flag "--import" is not allowed for python3 MCP servers');
		});

		test("ignores flags from other families for interpreters", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "node",
					args: ["--privileged"],
				}),
			).toBeNull();
		});
	});

	describe("package runner argument denylist", () => {
		test("blocks --index-url for uvx", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "uvx",
					args: ["--index-url", "https://evil.example"],
				}),
			).toBe('Flag "--index-url" is not allowed for uvx MCP servers');
		});

		test("blocks -c for npx", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "npx",
					args: ["-c", "console.log(1)"],
				}),
			).toBe('Flag "-c" is not allowed for npx MCP servers');
		});
	});

	describe("container argument denylist", () => {
		test("blocks --privileged for docker", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "docker",
					args: ["run", "--privileged"],
				}),
			).toBe('Flag "--privileged" is not allowed for docker MCP servers');
		});

		test("blocks bind mounts for podman", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "podman",
					args: ["-v", "/:/host"],
				}),
			).toBe('Flag "-v" is not allowed for podman MCP servers');
		});
	});

	describe("deno capability gating", () => {
		test("blocks the eval subcommand", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "deno",
					args: ["eval", "code"],
				}),
			).toBe('Subcommand "eval" is not allowed for deno MCP servers');
		});

		test("blocks all-permissions shorthand -A", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "deno",
					args: ["-A"],
				}),
			).toBe('Flag "-A" is not allowed for deno MCP servers');
		});

		test("blocks granular permission grants like --allow-net", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "deno",
					args: ["--allow-net"],
				}),
			).toBe('Flag "--allow-net" is not allowed for deno MCP servers');
		});

		test("blocks the --unstable flag family by prefix", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "deno",
					args: ["--unstable-kv"],
				}),
			).toBe('Flag "--unstable" is not allowed for deno MCP servers');
		});

		test("routes remote script URLs through the SSRF host guard", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "deno",
					args: ["run", "https://127.0.0.1/x.ts"],
				}),
			).toBe('URL host "127.0.0.1" is blocked for security reasons');
		});
	});

	describe("remote URL SSRF guard", () => {
		test("rejects a string that is not an absolute URL", async () => {
			expect(
				await validateMcpServerConfig({ type: "sse", url: "not a url" }),
			).toBe("URL must be a valid absolute URL");
		});

		test("rejects non-http protocols before any network work", async () => {
			expect(
				await validateMcpServerConfig({
					type: "http",
					url: "ftp://example.com/files",
				}),
			).toBe("URL must use http:// or https://");
		});

		test.each([
			"http://localhost:8080/mcp",
			"https://metadata.google.internal/computeMetadata",
			"http://api.localhost/mcp",
			"http://printer.local/mcp",
		])("blocks literal internal host %s without DNS", async (url) => {
			const hostname = new URL(url).hostname;
			expect(await validateMcpServerConfig({ type: "http", url })).toBe(
				`URL host "${hostname.replace(/^\[/, "").replace(/\]$/, "")}" is blocked for security reasons`,
			);
		});

		test("blocks a loopback IPv4 literal", async () => {
			expect(
				await validateMcpServerConfig({
					type: "http",
					url: "http://127.0.0.1/",
				}),
			).toBe('URL host "127.0.0.1" is blocked for security reasons');
		});

		test("blocks a hex-encoded loopback literal after URL canonicalization", async () => {
			expect(
				await validateMcpServerConfig({
					type: "http",
					url: "http://0x7f.0.0.1/",
				}),
			).toBe('URL host "127.0.0.1" is blocked for security reasons');
		});

		test("blocks a bracketed IPv6 loopback literal", async () => {
			expect(
				await validateMcpServerConfig({
					type: "streamable-http",
					url: "http://[::1]:3000/mcp",
				}),
			).toBe('URL host "::1" is blocked for security reasons');
		});

		test("accepts a public IP-literal URL without touching DNS", async () => {
			expect(
				await validateMcpServerConfig({
					type: "http",
					url: "http://93.184.216.34/mcp",
				}),
			).toBeNull();
		});
	});

	describe("args shape validation", () => {
		test("rejects non-array args", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "node",
					args: "server.js",
				}),
			).toBe("args must be an array of strings");
		});

		test("rejects non-string entries inside args", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "node",
					args: ["server.js", 42],
				}),
			).toBe("Each arg must be a string");
		});
	});

	describe("env validation", () => {
		function stdioWithEnv(env: unknown) {
			return { type: "stdio", command: "node", args: ["server.js"], env };
		}

		test.each([
			["a string", "PATH=/usr/bin"],
			["an array", ["A=1"]],
			["null", null],
		])("rejects env that is %s", async (_label, env) => {
			expect(await validateMcpServerConfig(stdioWithEnv(env))).toBe(
				"env must be a plain object of string key-value pairs",
			);
		});

		test("rejects a non-string env value", async () => {
			expect(await validateMcpServerConfig(stdioWithEnv({ RETRIES: 3 }))).toBe(
				"env.RETRIES must be a string",
			);
		});

		test.each(["__proto__", "constructor", "prototype", "$include"])(
			"blocks the dangerous object key env.%s",
			async (key) => {
				expect(
					await validateMcpServerConfig(stdioWithEnv({ [key]: "x" })),
				).toBe(`env key "${key}" is blocked for security reasons`);
			},
		);

		test("blocks denylisted env keys case-insensitively", async () => {
			expect(
				await validateMcpServerConfig(stdioWithEnv({ ld_preload: "/evil.so" })),
			).toBe('env variable "ld_preload" is not allowed for security reasons');
		});

		test("blocks env keys matching a denylisted prefix", async () => {
			expect(
				await validateMcpServerConfig(
					stdioWithEnv({ NPM_CONFIG_REGISTRY: "https://evil.example" }),
				),
			).toBe(
				'env variable "NPM_CONFIG_REGISTRY" matches blocked prefix NPM_CONFIG_ and is not allowed',
			);
		});

		test("blocks env values containing a null byte", async () => {
			expect(
				await validateMcpServerConfig(stdioWithEnv({ SAFE: "a\u0000b" })),
			).toBe('env variable "SAFE" contains a null byte and is not allowed');
		});

		test("accepts benign env values", async () => {
			expect(
				await validateMcpServerConfig(
					stdioWithEnv({ LOG_LEVEL: "info", MAX_CONNECTIONS: "10" }),
				),
			).toBeNull();
		});
	});

	describe("scalar fields and precedence", () => {
		test("rejects a non-string cwd", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "node",
					cwd: 7,
				}),
			).toBe("cwd must be a string");
		});

		test.each([
			["a negative number", -1],
			["Infinity", Number.POSITIVE_INFINITY],
			["NaN", Number.NaN],
			["a string", "5000"],
		])("rejects timeoutInMillis that is %s", async (_label, value) => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "node",
					timeoutInMillis: value as number,
				}),
			).toBe("timeoutInMillis must be a non-negative number");
		});

		test("reports the config type before inspecting env", async () => {
			expect(
				await validateMcpServerConfig({
					type: "carrier-pigeon",
					env: { LD_PRELOAD: "/evil.so" },
				}),
			).toBe(
				"Invalid config type. Must be one of: stdio, http, streamable-http, sse",
			);
		});

		test("accepts a fully valid stdio config", async () => {
			expect(
				await validateMcpServerConfig({
					type: "stdio",
					command: "bunx",
					args: ["@modelcontextprotocol/server-filesystem", "/tmp"],
					env: { LOG_LEVEL: "debug" },
					cwd: "/workspace",
					timeoutInMillis: 30_000,
				}),
			).toBeNull();
		});

		test("accepts a minimal stdio config with no optional fields", async () => {
			expect(
				await validateMcpServerConfig({ type: "stdio", command: "uvx" }),
			).toBeNull();
		});
	});
});
