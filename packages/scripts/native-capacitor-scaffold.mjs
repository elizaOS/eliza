/**
 * Generates the mechanical TypeScript and Rollup configuration shared by the
 * independently published native Capacitor plugins. Capability definitions,
 * web behavior, permissions, and native implementations remain package-owned.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  "packages/scripts/native-capacitor-scaffold.json",
);

const GENERATED_HEADER = `/**
 * Generated native Capacitor package build configuration. Change the scaffold
 * manifest or generator instead of editing this file directly.
 */`;

export function renderNativeCapacitorTsconfig(profile = "strict-es2022") {
  if (profile === "isolated-es2020") {
    return `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2020", "DOM"],
    "declaration": true,
    "declarationMap": true,
    "outDir": "dist/esm",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
`;
  }
  if (profile !== "strict-es2022") {
    throw new Error(`Unknown native Capacitor tsconfig profile: ${profile}`);
  }
  return `{
  "compilerOptions": {
    "allowSyntheticDefaultImports": true,
    "declaration": true,
    "declarationMap": true,
    "esModuleInterop": true,
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmitOnError": false,
    "noFallthroughCasesInSwitch": true,
    "noImplicitAny": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "outDir": "dist/esm",
    "rootDir": "src",
    "skipLibCheck": true,
    "sourceMap": true,
    "strict": true,
    "target": "ES2022"
  },
  "include": ["src"]
}
`;
}

export function renderNativeCapacitorRollup({
  globalName,
  nodeResolve = false,
}) {
  const importLine = nodeResolve
    ? `\nimport nodeResolve from "@rollup/plugin-node-resolve";\n`
    : "";
  const config = `{
  input: "dist/esm/index.js",
  output: [
    {
      file: "dist/plugin.js",
      format: "iife",
      name: ${JSON.stringify(globalName)},
      globals: { "@capacitor/core": "capacitorExports" },
      sourcemap: true,
      inlineDynamicImports: true,
    },
    {
      file: "dist/plugin.cjs.js",
      format: "cjs",
      sourcemap: true,
      inlineDynamicImports: true,
    },
  ],
  external: ["@capacitor/core"],${
    nodeResolve ? "\n  plugins: [nodeResolve()]," : ""
  }
}`;

  if (!nodeResolve) {
    return `${GENERATED_HEADER}\n\nexport default ${config};\n`;
  }

  const indentedConfig = config
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `${GENERATED_HEADER}${importLine}\nexport default [\n${indentedConfig},\n];\n`;
}

/**
 * Renders the common registration entry for a newly scaffolded plugin. It is
 * deliberately opt-in: packages with extra exports or global installation
 * behavior keep a hand-authored entry point.
 */
export function renderNativeCapacitorIndex({
  exportName,
  interfaceName,
  pluginName,
  webClass,
}) {
  return `/**
 * Registers the ${pluginName} Capacitor bridge and exposes its package-owned contract.
 */
import { registerPlugin } from "@capacitor/core";

import type { ${interfaceName} } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((module) => new module.${webClass}());

export const ${exportName} = registerPlugin<${interfaceName}>(${JSON.stringify(
    pluginName,
  )}, {
  web: loadWeb,
});
`;
}

/**
 * Renders the package-owned contract shell for a new native capability. Method
 * signatures are supplied by the capability rather than inferred centrally.
 */
export function renderNativeCapacitorDefinitions({ interfaceName, members }) {
  const body = members.map((member) => `  ${member}`).join("\n");
  return `/**
 * Defines the platform-neutral contract exposed by this native Capacitor capability.
 */

export interface ${interfaceName} {
${body}
}
`;
}

/**
 * Renders the WebPlugin class shell around capability-supplied implementations.
 * The caller must provide explicit browser behavior for every contract member.
 */
export function renderNativeCapacitorWeb({ interfaceName, webClass, members }) {
  const body = members.map((member) => `  ${member}`).join("\n\n");
  return `/**
 * Implements the explicit browser boundary for this native Capacitor capability.
 */
import { WebPlugin } from "@capacitor/core";

import type { ${interfaceName} } from "./definitions";

export class ${webClass} extends WebPlugin implements ${interfaceName} {
${body}
}
`;
}

export function loadNativeCapacitorScaffoldManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

export function collectNativeCapacitorScaffoldDrift(root = REPO_ROOT) {
  const manifest = loadNativeCapacitorScaffoldManifest();
  const expectedFiles = [
    ...manifest.tsconfigFamilies.flatMap((family) =>
      family.packages.map((packageName) => ({
        relativePath: `plugins/${packageName}/tsconfig.json`,
        contents: renderNativeCapacitorTsconfig(family.profile),
      })),
    ),
    ...manifest.rollupPackages.map((entry) => ({
      relativePath: `plugins/${entry.packageName}/rollup.config.mjs`,
      contents: renderNativeCapacitorRollup(entry),
    })),
  ];

  return expectedFiles.flatMap(({ relativePath, contents }) => {
    const absolutePath = path.join(root, relativePath);
    let actual;
    try {
      actual = readFileSync(absolutePath, "utf8");
    } catch {
      return [relativePath];
    }
    return actual === contents ? [] : [relativePath];
  });
}

export function writeNativeCapacitorScaffold(root = REPO_ROOT) {
  const manifest = loadNativeCapacitorScaffoldManifest();
  for (const family of manifest.tsconfigFamilies) {
    for (const packageName of family.packages) {
      writeFileSync(
        path.join(root, `plugins/${packageName}/tsconfig.json`),
        renderNativeCapacitorTsconfig(family.profile),
      );
    }
  }
  for (const entry of manifest.rollupPackages) {
    writeFileSync(
      path.join(root, `plugins/${entry.packageName}/rollup.config.mjs`),
      renderNativeCapacitorRollup(entry),
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) {
    writeNativeCapacitorScaffold();
  } else {
    const drift = collectNativeCapacitorScaffoldDrift();
    if (drift.length > 0) {
      console.error(
        `[native-capacitor-scaffold] Generated files drifted:\n${drift
          .map((file) => `- ${file}`)
          .join(
            "\n",
          )}\nRun: bun packages/scripts/native-capacitor-scaffold.mjs --write`,
      );
      process.exitCode = 1;
    }
  }
}
