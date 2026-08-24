/**
 * Unit tests for views-hero: validates hero asset relpath constant.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { HERO_SVG_RELPATH } from "./views-hero.ts";

describe("views-hero", () => {
	it("exports standard hero SVG relative path", () => {
		expect(HERO_SVG_RELPATH).toBe(path.join("assets", "hero.svg"));
	});
});
