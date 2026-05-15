import { describe, expect, it } from "vitest";
import { formatEntities } from "../entities.ts";
import type { Entity } from "../types/index.ts";

describe("formatEntities", () => {
	it("caps alias and metadata output for prompt hygiene", () => {
		const names = Array.from(
			{ length: 12 },
			(_, index) => `alias-${index + 1}`,
		);
		const entity = {
			id: "00000000-0000-0000-0000-000000000123",
			names,
			metadata: {
				bio: "x".repeat(2_500),
			},
		} as Entity;

		const rendered = formatEntities({ entities: [entity] });

		expect(rendered).toContain('"alias-1" aka "alias-2"');
		expect(rendered).toContain("(+4 aliases omitted)");
		expect(rendered).not.toContain("alias-12");
		expect(rendered).toContain("(truncated)");
		expect(rendered.length).toBeLessThan(2_500);
	});

	it("caps the number of rendered entities", () => {
		const entities = Array.from({ length: 30 }, (_, index) => ({
			id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
			names: [`entity-${String(index + 1).padStart(2, "0")}`],
		})) as Entity[];

		const rendered = formatEntities({ entities });

		expect(rendered).toContain("entity-01");
		expect(rendered).toContain("entity-10");
		expect(rendered).not.toContain("entity-11");
		expect(rendered).toContain("(+20 entities omitted)");
	});
});
