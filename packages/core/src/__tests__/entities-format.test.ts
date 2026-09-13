/**
 * Verifies formatEntities preserves complete aliases, metadata, and room
 * membership. Pure deterministic function test.
 */
import { describe, expect, it } from "vitest";
import { formatEntities, projectEntityDisplayMetadata } from "../entities.ts";
import type { Entity } from "../types/index.ts";

describe("formatEntities", () => {
	it("renders every alias and complete metadata", () => {
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
		expect(rendered).toContain("alias-12");
		expect(rendered).toContain("x".repeat(2_500));
	});

	it("drops image urls and the duplicated connector copies, keeps everything else", () => {
		const metadata = {
			avatarUrl: "https://cdn.example/a.webp",
			default: {
				name: "nubs",
				username: "nubs#0",
				avatarUrl: "https://cdn.example/a.webp",
			},
			discord: {
				id: "1284887060825509890",
				userName: "nubs",
				avatarUrl: "https://cdn.example/a.webp",
			},
			displayName: "nubs",
			originalId: "1284887060825509890",
			bio: "runs the show",
		};
		expect(projectEntityDisplayMetadata(metadata)).toEqual({
			discord: { id: "1284887060825509890", userName: "nubs" },
			displayName: "nubs",
			bio: "runs the show",
		});
		const rendered = formatEntities({
			entities: [
				{
					id: "00000000-0000-0000-0000-000000000124",
					names: ["nubs"],
					metadata,
				} as Entity,
			],
		});
		expect(rendered).not.toContain("avatarUrl");
		expect(rendered).not.toContain('"default"');
		expect(rendered).toContain("runs the show");
	});

	it("renders every entity", () => {
		const entities = Array.from({ length: 30 }, (_, index) => ({
			id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
			names: [`entity-${String(index + 1).padStart(2, "0")}`],
		})) as Entity[];

		const rendered = formatEntities({ entities });

		expect(rendered).toContain("entity-01");
		expect(rendered).toContain("entity-10");
		expect(rendered).toContain("entity-11");
		expect(rendered).toContain("entity-30");
	});
});
