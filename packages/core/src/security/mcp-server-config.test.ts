import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup }));

import { validateMcpServerConfig } from "./mcp-server-config";

describe("validateMcpServerConfig remote host policy", () => {
	beforeEach(() => {
		lookup.mockReset();
		lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
	});

	it.each([
		"localhost",
		"app.localhost",
		"printer.local",
		"metadata.google.internal",
		"foo.internal",
		"bar.ec2.internal",
		"node-1.compute.internal",
	])("blocks %s via the shared denylist without resolving it", async (host) => {
		for (const type of ["http", "streamable-http", "sse"]) {
			expect(
				await validateMcpServerConfig({ type, url: `https://${host}/mcp` }),
			).toBe(`URL host "${host}" is blocked for security reasons`);
		}
		expect(lookup).not.toHaveBeenCalled();
	});

	it("resolves and accepts a public host", async () => {
		expect(
			await validateMcpServerConfig({
				type: "http",
				url: "https://mcp.example.com/mcp",
			}),
		).toBeNull();
		expect(lookup).toHaveBeenCalledWith("mcp.example.com", { all: true });
	});

	it("still rejects a public name that resolves to a private address", async () => {
		lookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
		expect(
			await validateMcpServerConfig({
				type: "http",
				url: "https://mcp.example.com/mcp",
			}),
		).toBe('URL host "mcp.example.com" resolves to blocked address 10.0.0.5');
	});
});
