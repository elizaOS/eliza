/**
 * Verifies that VIEWS create seeds a complete standalone GUI plugin contract.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedGuiViewScaffold } from "./views-create-scaffold.js";

const tempDirs: string[] = [];

function scaffoldFixture(): string {
	const workdir = mkdtempSync(path.join(os.tmpdir(), "view-scaffold-"));
	tempDirs.push(workdir);
	mkdirSync(path.join(workdir, "src/providers"), { recursive: true });
	mkdirSync(path.join(workdir, "tests"), { recursive: true });
	writeFileSync(
		path.join(workdir, "package.json"),
		JSON.stringify({
			name: "@local/plugin-proof-surface",
			scripts: {
				build: "tsc --noCheck -p tsconfig.build.json",
				test: "vitest run --config ./vitest.config.ts",
			},
			dependencies: { "@elizaos/core": "latest" },
			devDependencies: { typescript: "^6.0.3", vitest: "^4.0.0" },
		}),
	);
	writeFileSync(
		path.join(workdir, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: { strict: true },
			include: ["src/**/*.ts", "tests/**/*.ts"],
		}),
	);
	return workdir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("seedGuiViewScaffold", () => {
	it("writes the registered view, React proof surface, real test, and browser build", async () => {
		const workdir = scaffoldFixture();
		const intent = "Show a signed audit ledger with a live refresh control";

		await seedGuiViewScaffold({
			workdir,
			viewId: "proof-surface",
			displayName: "Proof Surface",
			intent,
		});

		const index = readFileSync(path.join(workdir, "src/index.ts"), "utf8");
		expect(index).toContain("interface ViewEnabledPlugin extends Plugin");
		expect(index).toContain('id: "proof-surface"');
		expect(index).toContain('modalities: ["gui"]');
		expect(index).toContain('viewKind: "release"');
		expect(index).toContain('bundlePath: "dist/views/bundle.js"');
		expect(index).toContain('componentExport: "PluginView"');
		expect(index).toContain('heroImagePath: "assets/hero.svg"');

		const component = readFileSync(
			path.join(workdir, "src/views/PluginView.tsx"),
			"utf8",
		);
		expect(component).toContain(
			'VIEW_SCAFFOLD_MARKER = "eliza-view-scaffold:proof-surface"',
		);
		expect(component).toContain(`VIEW_INTENT = ${JSON.stringify(intent)}`);
		expect(component).toContain("data-eliza-view-marker");
		expect(component).toContain("export function PluginView()");

		const testSource = readFileSync(
			path.join(workdir, "tests/view-render.test.tsx"),
			"utf8",
		);
		expect(testSource).toContain("renderToStaticMarkup(<PluginView />)");
		expect(testSource).toContain("VIEW_SCAFFOLD_MARKER");
		expect(testSource).toContain(
			`expect(VIEW_INTENT).toBe(${JSON.stringify(intent)})`,
		);

		const viteConfig = readFileSync(
			path.join(workdir, "vite.config.views.ts"),
			"utf8",
		);
		expect(viteConfig).toContain(
			'entry: path.resolve(process.cwd(), "src/views/view-bundle.ts")',
		);
		expect(viteConfig).toContain('outDir: "dist/views"');
		expect(viteConfig).toContain('fileName: () => "bundle.js"');
		expect(viteConfig).toContain('"react/jsx-runtime"');

		const packageJson = JSON.parse(
			readFileSync(path.join(workdir, "package.json"), "utf8"),
		) as {
			scripts: Record<string, string>;
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		expect(packageJson.scripts.build).toContain(
			"vite build --config vite.config.views.ts",
		);
		expect(packageJson.scripts["build:views"]).toBe(
			"vite build --config vite.config.views.ts",
		);
		expect(packageJson.scripts.lint).toBe("biome check src/ tests/");
		expect(packageJson.dependencies.react).toBe("^19.0.0");
		expect(packageJson.dependencies["react-dom"]).toBe("^19.0.0");
		expect(packageJson.devDependencies["@biomejs/biome"]).toBe("2.5.1");
		expect(packageJson.devDependencies.vite).toBe("^8.0.0");

		const tsconfig = JSON.parse(
			readFileSync(path.join(workdir, "tsconfig.json"), "utf8"),
		) as { compilerOptions: { jsx?: string }; include: string[] };
		expect(tsconfig.compilerOptions.jsx).toBe("react-jsx");
		expect(tsconfig.include).toContain("src/**/*.tsx");
		expect(tsconfig.include).toContain("tests/**/*.tsx");
	});
});
