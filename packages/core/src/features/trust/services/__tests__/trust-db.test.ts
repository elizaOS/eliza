import { describe, expect, it } from "vitest";
import { getDb } from "./db.ts";

describe("getDb", () => {
	it("returns the runtime db handle when present", () => {
		const db = { select: () => {} };
		const runtime = { db } as never;
		expect(getDb(runtime)).toBe(db);
	});

	it("throws when no db is attached", () => {
		expect(() => getDb({} as never)).toThrow("[trust] Database not available");
		expect(() => getDb({ db: undefined } as never)).toThrow(
			"[trust] Database not available",
		);
	});
});
