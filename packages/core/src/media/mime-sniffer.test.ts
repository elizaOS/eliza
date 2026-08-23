/**
 * Tests for the Node MIME sniffing boundary backed by `file-type`.
 * The lazy dynamic import is mocked so the test never touches the network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	fileTypeFromBuffer: vi.fn(),
}));

vi.mock("file-type", () => ({
	fileTypeFromBuffer: mocks.fileTypeFromBuffer,
}));

describe("Node sniffMime (file-type boundary)", () => {
	beforeEach(() => {
		mocks.fileTypeFromBuffer.mockReset();
		vi.resetModules();
	});

	it("returns undefined when no buffer is passed", async () => {
		const { sniffMime } = await import("./mime-sniffer.ts");
		await expect(sniffMime()).resolves.toBeUndefined();
		expect(mocks.fileTypeFromBuffer).not.toHaveBeenCalled();
	});

	it("delegates an empty (but present) buffer to file-type", async () => {
		const { sniffMime } = await import("./mime-sniffer.ts");
		mocks.fileTypeFromBuffer.mockResolvedValue(undefined);
		await expect(sniffMime(new Uint8Array(0))).resolves.toBeUndefined();
		expect(mocks.fileTypeFromBuffer).toHaveBeenCalledTimes(1);
	});

	it("delegates to file-type and returns the sniffed mime", async () => {
		const { sniffMime } = await import("./mime-sniffer.ts");
		mocks.fileTypeFromBuffer.mockResolvedValue({
			ext: "png",
			mime: "image/png",
		});
		const buffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		await expect(sniffMime(buffer)).resolves.toBe("image/png");
		expect(mocks.fileTypeFromBuffer).toHaveBeenCalledTimes(1);
		expect(mocks.fileTypeFromBuffer).toHaveBeenCalledWith(buffer);
	});

	it("returns undefined when file-type reports no match", async () => {
		const { sniffMime } = await import("./mime-sniffer.ts");
		mocks.fileTypeFromBuffer.mockResolvedValue(undefined);
		await expect(sniffMime(new Uint8Array([1, 2, 3]))).resolves.toBeUndefined();
	});

	it("returns undefined when file-type lacks fileTypeFromBuffer", async () => {
		const { sniffMime } = await import("./mime-sniffer.ts");
		mocks.fileTypeFromBuffer.mockImplementation(() => undefined);
		await expect(sniffMime(new Uint8Array([1, 2, 3]))).resolves.toBeUndefined();
	});

	it("caches the lazily imported module across calls", async () => {
		const { sniffMime } = await import("./mime-sniffer.ts");
		mocks.fileTypeFromBuffer.mockResolvedValue({
			ext: "png",
			mime: "image/png",
		});
		const buffer = new Uint8Array([1]);
		await sniffMime(buffer);
		await sniffMime(buffer);
		expect(mocks.fileTypeFromBuffer).toHaveBeenCalledTimes(2);
	});
});
