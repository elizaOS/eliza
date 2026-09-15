import { describe, expect, it } from "vitest";
import { navigationDestinationReference } from "../actions/view-navigation-context.js";
import type { ViewSummary } from "../actions/views-client.js";
import { formatNavigationRepairCatalog } from "./view-context-planning.js";

function decode(prompt: string) {
	const line = prompt
		.split("\n")
		.find((value) => value.startsWith("Authorized live catalog: "));
	if (!line) throw new Error("Missing catalog");
	const value = JSON.parse(line.slice("Authorized live catalog: ".length));
	return {
		value,
		views: Array.isArray(value)
			? value
			: value.entries.map((entry: Record<string, unknown>) => ({
					...value.defaults,
					...entry,
				})),
	};
}

function fixture(): ViewSummary[] {
	return Array.from({ length: 30 }, (_, index) => ({
		id: index < 2 ? "duplicate-id" : `custom-${index}`,
		label: `Custom ${index}`,
		pluginName: "custom",
		viewType: "gui" as const,
		available: true,
		roleGate: { minRole: "OWNER" as const },
		capabilities: [
			{
				id: "inspect",
				description: "Preserve this complete capability description",
				params: { type: "object" as const, properties: {} },
			},
		],
		...JSON.parse(
			'{"__proto__":{"polluted":true},"constructor":"literal","defaults":{"available":false},"entries":[null],"unknown":{"nested":[null,false,0,"",{"viewType":"other"}]}}',
		),
	}));
}

describe("navigation repair catalog encoding", () => {
	it("roundtrips all serialized reference fields, duplicate IDs and order", () => {
		const catalog = fixture();
		const snapshot = JSON.stringify(catalog);
		const original = JSON.parse(
			JSON.stringify(catalog.map(navigationDestinationReference)),
		);
		const prompt = formatNavigationRepairCatalog(catalog);
		const { value, views } = decode(prompt);
		expect(value.defaults).toEqual({ viewType: "gui", available: true });
		expect(views).toEqual(original);
		expect(Object.hasOwn(views[0], "__proto__")).toBe(true);
		expect(views[0].capabilities[0].paramsDeferred).toBe(true);
		expect(JSON.stringify(catalog)).toBe(snapshot);
		expect(prompt.length).toBeLessThan(
			`Authorized live catalog: ${JSON.stringify(original)}`.length,
		);
	});

	it("keeps missing, undefined, null and differing values distinct", () => {
		const catalog = fixture();
		delete catalog[0].viewType;
		catalog[1].viewType = undefined;
		Object.assign(catalog[2], { viewType: null, available: null });
		Object.assign(catalog[3], {
			viewType: "future-modality",
			available: false,
		});
		const { value, views } = decode(formatNavigationRepairCatalog(catalog));
		expect(Array.isArray(value)).toBe(true);
		expect(views).toEqual(
			JSON.parse(JSON.stringify(catalog.map(navigationDestinationReference))),
		);
		expect(Object.hasOwn(views[0], "viewType")).toBe(false);
		expect(Object.hasOwn(views[1], "viewType")).toBe(false);
		expect(views[2].viewType).toBeNull();
	});

	it("can factor one shared field without inventing missing metadata", () => {
		const catalog = fixture();
		delete catalog[0].viewType;
		const { value, views } = decode(formatNavigationRepairCatalog(catalog));
		expect(value.defaults).toEqual({ available: true });
		expect(views).toEqual(
			JSON.parse(JSON.stringify(catalog.map(navigationDestinationReference))),
		);
		expect(Object.hasOwn(views[0], "viewType")).toBe(false);
	});

	it.each([0, 1, 2])(
		"keeps the original array when %i entries would not shrink",
		(size) => {
			const catalog = fixture().slice(0, size);
			expect(formatNavigationRepairCatalog(catalog)).toBe(
				`Authorized live catalog: ${JSON.stringify(catalog.map(navigationDestinationReference))}`,
			);
		},
	);
});
