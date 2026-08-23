import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
	secretContextFromMessage: vi.fn(),
}));

vi.mock("../../../logger.ts", () => ({ logger: mocks.logger }));
vi.mock("../secret-context.ts", () => ({
	secretContextFromMessage: (...a: unknown[]) =>
		mocks.secretContextFromMessage(...a),
}));
vi.mock("../services/secrets.ts", () => ({
	SECRETS_SERVICE_TYPE: "SECRETS",
}));

import { checkSecretHandler } from "./check-secret.ts";

describe("checkSecretHandler", () => {
	it("returns failure when the secrets service is unavailable", async () => {
		const runtime = { getService: () => null } as never;
		const result = await checkSecretHandler(runtime, {} as never);
		expect(result.success).toBe(false);
		expect(result.text).toBe("Secrets service not available");
	});

	it("reports which keys exist without returning values", async () => {
		const service = {
			exists: vi.fn(async (key: string) => key === "API_KEY"),
		};
		const runtime = { getService: () => service } as never;
		const result = await checkSecretHandler(runtime, {} as never, undefined, {
			parameters: { key: ["api-key", "MISSING_KEY"] },
		} as never);
		expect(result.success).toBe(true);
		const data = result.data as { exists: string[]; missing: string[] };
		expect(data.exists).toContain("API_KEY");
		expect(data.missing).toContain("MISSING_KEY");
		// 绝不返回值
		expect(JSON.stringify(result)).not.toContain("the-value");
	});

	it("handles string and missing key params", async () => {
		const service = { exists: vi.fn(async () => false) };
		const runtime = { getService: () => service } as never;
		const r1 = await checkSecretHandler(runtime, {} as never, undefined, {
			parameters: { key: "SINGLE" },
		} as never);
		expect(r1.success).toBe(true);
		const r2 = await checkSecretHandler(runtime, {} as never, undefined, {
			parameters: {},
		} as never);
		expect(r2.success).toBe(true);
	});
});
