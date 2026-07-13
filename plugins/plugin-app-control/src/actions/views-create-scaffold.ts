/**
 * Seeds the browser-loadable GUI baseline used by VIEWS create.
 *
 * The generic min-plugin template intentionally contains no UI dependencies or
 * view declaration. This module turns that copied template into a complete,
 * standalone view plugin before a coding agent begins the requested design.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { ElizaError } from "@elizaos/core";

export interface SeedGuiViewScaffoldInput {
	workdir: string;
	viewId: string;
	displayName: string;
	intent: string;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireJsonObject(value: unknown, source: string): JsonObject {
	if (!isJsonObject(value)) {
		throw new ElizaError(`${source} must contain a JSON object`, {
			code: "VIEW_SCAFFOLD_CONFIG_OBJECT_REQUIRED",
			context: { source },
		});
	}
	return value;
}

function objectField(
	record: JsonObject,
	key: string,
	source: string,
): JsonObject {
	const value = record[key];
	if (value === undefined) {
		const created: JsonObject = {};
		record[key] = created;
		return created;
	}
	if (!isJsonObject(value)) {
		throw new ElizaError(`${source}.${key} must be a JSON object`, {
			code: "VIEW_SCAFFOLD_CONFIG_FIELD_INVALID",
			context: { source, field: key, expected: "object" },
		});
	}
	return value;
}

function requiredStringField(
	record: JsonObject,
	key: string,
	source: string,
): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ElizaError(`${source}.${key} must be a non-empty string`, {
			code: "VIEW_SCAFFOLD_CONFIG_FIELD_INVALID",
			context: { source, field: key, expected: "non-empty string" },
		});
	}
	return value;
}

function sourceString(value: string): string {
	return JSON.stringify(value);
}

function pluginIndexSource({
	packageName,
	viewId,
	displayName,
	intent,
}: {
	packageName: string;
	viewId: string;
	displayName: string;
	intent: string;
}): string {
	return `/**
 * Runtime entrypoint for a standalone plugin-contributed GUI view.
 *
 * The local view shape keeps this scaffold compatible with installed core
 * packages that predate Plugin.views while preserving the current runtime
 * manifest exactly.
 */

import type { Plugin } from "@elizaos/core";
import { infoProvider } from "./providers/info.js";

interface StandaloneGuiView {
  id: string;
  label: string;
  description: string;
  icon: string;
  path: string;
  modalities: ["gui"];
  viewKind: "release";
  bundlePath: string;
  componentExport: string;
  heroImagePath: string;
  visibleInManager: boolean;
  desktopTabEnabled: boolean;
}

interface ViewEnabledPlugin extends Plugin {
  views: StandaloneGuiView[];
}

const plugin: ViewEnabledPlugin = {
  name: ${sourceString(packageName)},
  description: ${sourceString(`${displayName} GUI view for: ${intent}`)},
  providers: [infoProvider],
  views: [
    {
      id: ${sourceString(viewId)},
      label: ${sourceString(displayName)},
      description: ${sourceString(intent)},
      icon: "PanelTopOpen",
      path: ${sourceString(`/${viewId}`)},
      modalities: ["gui"],
      viewKind: "release",
      bundlePath: "dist/views/bundle.js",
      componentExport: "PluginView",
      heroImagePath: "assets/hero.svg",
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default plugin;
export { infoProvider, plugin };
`;
}

function componentSource({
	viewId,
	displayName,
	intent,
}: {
	viewId: string;
	displayName: string;
	intent: string;
}): string {
	return `/**
 * Browser component for the plugin's GUI view.
 *
 * The visible intent and stable marker give the coding agent and the live E2E
 * verifier an unambiguous baseline to customize and prove after hot-loading.
 */

import type { CSSProperties } from "react";

export const VIEW_ID = ${sourceString(viewId)};
export const VIEW_LABEL = ${sourceString(displayName)};
export const VIEW_INTENT = ${sourceString(intent)};
export const VIEW_SCAFFOLD_MARKER = ${sourceString(`eliza-view-scaffold:${viewId}`)};

const styles: Record<string, CSSProperties> = {
  shell: {
    alignItems: "center",
    background: "#111111",
    color: "#f5f5f4",
    display: "flex",
    justifyContent: "center",
    minHeight: "100%",
    padding: "clamp(24px, 6vw, 72px)",
  },
  panel: {
    background: "#1c1917",
    border: "1px solid #44403c",
    borderRadius: 20,
    boxShadow: "0 24px 70px rgba(0, 0, 0, 0.36)",
    maxWidth: 760,
    padding: "clamp(28px, 5vw, 56px)",
    width: "100%",
  },
  eyebrow: {
    color: "#fb923c",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: "0.12em",
    margin: "0 0 14px",
    textTransform: "uppercase",
  },
  title: {
    fontSize: "clamp(36px, 7vw, 68px)",
    letterSpacing: "-0.04em",
    lineHeight: 0.96,
    margin: 0,
  },
  intent: {
    color: "#d6d3d1",
    fontSize: 18,
    lineHeight: 1.65,
    margin: "28px 0 0",
  },
  status: {
    borderLeft: "3px solid #f97316",
    color: "#a8a29e",
    fontSize: 14,
    lineHeight: 1.5,
    marginTop: 36,
    paddingLeft: 16,
  },
};

export function PluginView() {
  return (
    <main
      aria-labelledby="${viewId}-title"
      data-eliza-view-id={VIEW_ID}
      data-eliza-view-marker={VIEW_SCAFFOLD_MARKER}
      style={styles.shell}
    >
      <section style={styles.panel}>
        <p style={styles.eyebrow}>View scaffold ready</p>
        <h1 id="${viewId}-title" style={styles.title}>
          {VIEW_LABEL}
        </h1>
        <p style={styles.intent}>{VIEW_INTENT}</p>
        <p role="status" style={styles.status}>
          The Plugin.views manifest, React export, render test, and browser
          bundle are connected. Build the requested experience from this
          working surface.
        </p>
      </section>
    </main>
  );
}

export default PluginView;
`;
}

function componentTestSource({
	viewId,
	intent,
}: {
	viewId: string;
	intent: string;
}): string {
	return `/**
 * Exercises the actual React view export through server rendering.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PluginView, {
  VIEW_ID,
  VIEW_INTENT,
  VIEW_SCAFFOLD_MARKER,
} from "../src/views/PluginView.js";

describe("standalone GUI view", () => {
  it("renders the registered identity, creation intent, and proof marker", () => {
    const html = renderToStaticMarkup(<PluginView />);

    expect(VIEW_ID).toBe(${sourceString(viewId)});
    expect(VIEW_INTENT).toBe(${sourceString(intent)});
    expect(html).toContain(\`data-eliza-view-id="\${VIEW_ID}"\`);
    expect(html).toContain(VIEW_SCAFFOLD_MARKER);
    expect(html).toContain("View scaffold ready");
  });
});
`;
}

const VIEW_BUNDLE_SOURCE = `/**
 * Browser-bundle entrypoint consumed by the Eliza view loader.
 */

export { default, PluginView } from "./PluginView.js";
`;

const VITE_CONFIG_SOURCE = `/**
 * Produces one browser-loadable ES module for the plugin view registry.
 */

import path from "node:path";
import { defineConfig } from "vite";

const hostExternals = new Set([
  "react",
  "react/jsx-dev-runtime",
  "react/jsx-runtime",
]);

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: "dist/views",
    sourcemap: true,
    lib: {
      entry: path.resolve(process.cwd(), "src/views/view-bundle.ts"),
      formats: ["es"],
      fileName: () => "bundle.js",
    },
    rollupOptions: {
      external: (id) =>
        hostExternals.has(id) ||
        [...hostExternals].some((external) => id.startsWith(\`\${external}/\`)),
      output: {
        exports: "named",
        codeSplitting: false,
      },
    },
  },
  define: {
    "import.meta.env.DEV": JSON.stringify(false),
    "import.meta.env.PROD": JSON.stringify(true),
    "import.meta.env.MODE": JSON.stringify("production"),
    "import.meta.env.SSR": JSON.stringify(false),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
`;

const VITEST_CONFIG_SOURCE = `/**
 * Runs the standalone plugin's runtime and React rendering tests.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "**/node_modules/**"],
    environment: "node",
  },
});
`;

/**
 * Converts an already-copied min-plugin directory into a working GUI plugin.
 */
export async function seedGuiViewScaffold({
	workdir,
	viewId,
	displayName,
	intent,
}: SeedGuiViewScaffoldInput): Promise<void> {
	const packageJsonPath = path.join(workdir, "package.json");
	const packageJson = requireJsonObject(
		JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as unknown,
		"package.json",
	);
	const packageName = requiredStringField(packageJson, "name", "package.json");
	const scripts = objectField(packageJson, "scripts", "package.json");
	const dependencies = objectField(packageJson, "dependencies", "package.json");
	const devDependencies = objectField(
		packageJson,
		"devDependencies",
		"package.json",
	);

	scripts.build =
		"tsc --noCheck -p tsconfig.build.json && vite build --config vite.config.views.ts";
	scripts["build:views"] = "vite build --config vite.config.views.ts";
	scripts.lint = "biome check src/ tests/";
	dependencies.react = "^19.0.0";
	dependencies["react-dom"] = "^19.0.0";
	devDependencies["@biomejs/biome"] = "2.5.1";
	devDependencies["@types/react"] = "^19.0.0";
	devDependencies["@types/react-dom"] = "^19.0.0";
	devDependencies.vite = "^8.0.0";

	const tsconfigPath = path.join(workdir, "tsconfig.json");
	const tsconfig = requireJsonObject(
		JSON.parse(await fs.readFile(tsconfigPath, "utf8")) as unknown,
		"tsconfig.json",
	);
	const compilerOptions = objectField(
		tsconfig,
		"compilerOptions",
		"tsconfig.json",
	);
	compilerOptions.jsx = "react-jsx";
	tsconfig.include = [
		"src/**/*.ts",
		"src/**/*.tsx",
		"tests/**/*.ts",
		"tests/**/*.tsx",
	];

	await fs.mkdir(path.join(workdir, "src/views"), { recursive: true });
	await fs.mkdir(path.join(workdir, "tests"), { recursive: true });
	await Promise.all([
		fs.writeFile(
			packageJsonPath,
			`${JSON.stringify(packageJson, null, 2)}\n`,
			"utf8",
		),
		fs.writeFile(
			tsconfigPath,
			`${JSON.stringify(tsconfig, null, 2)}\n`,
			"utf8",
		),
		fs.writeFile(
			path.join(workdir, "src/index.ts"),
			pluginIndexSource({ packageName, viewId, displayName, intent }),
			"utf8",
		),
		fs.writeFile(
			path.join(workdir, "src/views/PluginView.tsx"),
			componentSource({ viewId, displayName, intent }),
			"utf8",
		),
		fs.writeFile(
			path.join(workdir, "src/views/view-bundle.ts"),
			VIEW_BUNDLE_SOURCE,
			"utf8",
		),
		fs.writeFile(
			path.join(workdir, "tests/view-render.test.tsx"),
			componentTestSource({ viewId, intent }),
			"utf8",
		),
		fs.writeFile(
			path.join(workdir, "vite.config.views.ts"),
			VITE_CONFIG_SOURCE,
			"utf8",
		),
		fs.writeFile(
			path.join(workdir, "vitest.config.ts"),
			VITEST_CONFIG_SOURCE,
			"utf8",
		),
	]);
}
