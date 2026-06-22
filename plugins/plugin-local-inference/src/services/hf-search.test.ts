import { afterEach, describe, expect, it, vi } from "vitest";
import {
	searchHuggingFaceGguf,
	searchModelHubGguf,
	searchModelScopeGguf,
} from "./hf-search";

describe("local model hub compatibility search", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("does not query Hugging Face and returns no custom models", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(searchHuggingFaceGguf("qwen", 4)).resolves.toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not query ModelScope and returns no custom models", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(searchModelScopeGguf("qwen", 4)).resolves.toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps the generic hub shim no-network for all supported hubs", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(searchModelHubGguf("qwen", "huggingface", 4)).resolves.toEqual(
			[],
		);
		await expect(searchModelHubGguf("qwen", "modelscope", 4)).resolves.toEqual(
			[],
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
