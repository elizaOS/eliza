/**
 * Rejects an unpinned template toolchain before scaffold generation using a
 * real temporary package manifest. Generated build/render coverage is packaged.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { seedGuiViewScaffold } from "./views-create-scaffold.js";

it("rejects a copied template without an exact Biome pin", async () => {
	const workdir = mkdtempSync(path.join(os.tmpdir(), "view-scaffold-"));
	try {
		writeFileSync(
			path.join(workdir, "package.json"),
			JSON.stringify({
				name: "@local/plugin-proof-surface",
				devDependencies: { "@biomejs/biome": "^2.5.8" },
			}),
		);
		await expect(
			seedGuiViewScaffold({
				workdir,
				viewId: "proof-surface",
				displayName: "Proof Surface",
				intent: "Show proof",
			}),
		).rejects.toMatchObject({
			code: "VIEW_SCAFFOLD_BIOME_VERSION_REQUIRED",
		});
	} finally {
		rmSync(workdir, { recursive: true, force: true });
	}
});
