/**
 * Behavioral coverage for the documents plugin-factory barrel: drives the real
 * createDocumentsPlugin through its enableActions/enableProviders branching
 * and defaults, the three exported presets, fresh-instance construction, and
 * the dispose() service-shutdown lifecycle against a minimal runtime stub.
 */
import { describe, expect, test, vi } from "vitest";
import type { IAgentRuntime } from "../../types";
import {
	createDocumentsPlugin,
	DocumentService,
	documentsPlugin,
	documentsPluginCore,
	documentsPluginHeadless,
	documentsProvider,
} from "./index";

function runtimeWithService(
	getService: (serviceType: string) => unknown,
): IAgentRuntime {
	return { getService } as unknown as IAgentRuntime;
}

describe("createDocumentsPlugin", () => {
	test("registers the DocumentService class on every assembled plugin", () => {
		for (const plugin of [
			createDocumentsPlugin(),
			createDocumentsPlugin({ enableActions: false }),
			createDocumentsPlugin({
				enableActions: true,
				enableProviders: false,
			}),
			documentsPlugin,
			documentsPluginCore,
			documentsPluginHeadless,
		]) {
			expect(plugin.services).toEqual([DocumentService]);
			expect(DocumentService.serviceType).toBe("documents");
		}
	});

	test("enables actions and providers by default", () => {
		const plugin = createDocumentsPlugin();
		expect(plugin.providers).toEqual([documentsProvider]);
		expect(plugin.actions).toEqual([
			expect.objectContaining({ name: "DOCUMENT" }),
		]);
	});

	test("disableProviders removes the provider surface but keeps DOCUMENT actions", () => {
		const plugin = createDocumentsPlugin({ enableProviders: false });
		expect(plugin.providers).toEqual([]);
		expect((plugin.actions ?? []).map((action) => action.name)).toEqual([
			"DOCUMENT",
		]);
	});

	test("disableActions removes every action but keeps the DOCUMENTS provider", () => {
		const plugin = createDocumentsPlugin({ enableActions: false });
		expect(plugin.actions).toEqual([]);
		expect((plugin.providers ?? []).map((provider) => provider.name)).toEqual([
			"DOCUMENTS",
		]);
	});

	test("disabling both leaves an empty action and provider surface", () => {
		const plugin = createDocumentsPlugin({
			enableActions: false,
			enableProviders: false,
		});
		expect(plugin.actions).toEqual([]);
		expect(plugin.providers).toEqual([]);
		expect(plugin.services).toEqual([DocumentService]);
	});

	test("returns a distinct plugin object per call", () => {
		const first = createDocumentsPlugin();
		const second = createDocumentsPlugin();
		expect(first).not.toBe(second);
		expect(first).not.toBe(documentsPlugin);
	});
});

describe("documents plugin presets", () => {
	test("default preset exposes name, description, and full surfaces", () => {
		expect(documentsPlugin.name).toBe("documents");
		expect(documentsPlugin.description).toContain(
			"Retrieval Augmented Generation",
		);
		expect(documentsPlugin.providers).toHaveLength(1);
		expect(documentsPlugin.actions).toHaveLength(1);
	});

	test("core preset is provider-only", () => {
		expect(documentsPluginCore.name).toBe("documents");
		expect(documentsPluginCore.actions).toEqual([]);
		expect(
			(documentsPluginCore.providers ?? []).map((provider) => provider.name),
		).toEqual(["DOCUMENTS"]);
	});

	test("headless preset retains both action and provider surfaces", () => {
		expect(documentsPluginHeadless.name).toBe("documents");
		expect(
			(documentsPluginHeadless.actions ?? []).map((action) => action.name),
		).toEqual(["DOCUMENT"]);
		expect(
			(documentsPluginHeadless.providers ?? []).map(
				(provider) => provider.name,
			),
		).toEqual(["DOCUMENTS"]);
	});
});

describe("documents plugin dispose", () => {
	test("stops the registered DocumentService looked up by its serviceType", async () => {
		const stop = vi.fn(async () => {});
		const getService = vi.fn(() => ({ stop }));
		const plugin = createDocumentsPlugin();

		await plugin.dispose(runtimeWithService(getService));

		expect(getService).toHaveBeenCalledWith("documents");
		expect(stop).toHaveBeenCalledTimes(1);
	});

	test("awaits service shutdown before dispose resolves", async () => {
		let stopped = false;
		const service = {
			stop: async () => {
				await Promise.resolve();
				stopped = true;
			},
		};

		await createDocumentsPlugin().dispose(runtimeWithService(() => service));

		expect(stopped).toBe(true);
	});

	test("resolves without throwing when no DocumentService is registered", async () => {
		const plugin = documentsPluginCore;

		await expect(
			plugin.dispose(runtimeWithService(() => null)),
		).resolves.toBeUndefined();
	});
});
