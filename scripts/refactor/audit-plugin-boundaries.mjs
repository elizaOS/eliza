#!/usr/bin/env bun
// Audits runtime plugin boundaries.
//
// `plugins/plugin-*` packages are runtime plugins. They may depend on
// `@elizaos/core` and external libraries, but must not import or declare a
// dependency on `@elizaos/shared`; shared is an app/UI/shared-contract layer.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  REPO_ROOT,
  findImportSpecifiers,
  walkSourceFiles,
  walkWorkspacePackages,
} from "./lib/util.mjs";

const RUNTIME_PLUGIN_DIR_RE = /(^|\/)plugins\/plugin-[^/]+$/;
const SHARED_PACKAGE = "@elizaos/shared";

function main() {
  const violations = [];
  const runtimePlugins = walkWorkspacePackages().filter((pkg) => {
    const relDir = relative(REPO_ROOT, pkg.dir).replace(/\\/g, "/");
    return RUNTIME_PLUGIN_DIR_RE.test(relDir);
  });

  for (const plugin of runtimePlugins) {
    const relDir = relative(REPO_ROOT, plugin.dir).replace(/\\/g, "/");
    for (const depField of ["dependencies", "devDependencies", "peerDependencies"]) {
      if (plugin.pkg[depField]?.[SHARED_PACKAGE]) {
        violations.push({
          file: `${relDir}/package.json`,
          reason: `${depField}.${SHARED_PACKAGE}`,
        });
      }
    }

    for (const tsconfigName of ["tsconfig.json", "tsconfig.build.json"]) {
      const tsconfigPath = join(plugin.dir, tsconfigName);
      let tsconfig;
      try {
        tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
      } catch {
        continue;
      }
      const paths = tsconfig.compilerOptions?.paths ?? {};
      if (paths[SHARED_PACKAGE] || paths[`${SHARED_PACKAGE}/*`]) {
        violations.push({
          file: `${relDir}/${tsconfigName}`,
          reason: `compilerOptions.paths contains ${SHARED_PACKAGE}`,
        });
      }
    }

    for (const file of walkSourceFiles(plugin.dir)) {
      const source = readFileSync(file, "utf8");
      for (const spec of findImportSpecifiers(source)) {
        if (
          spec.specifier === SHARED_PACKAGE ||
          spec.specifier.startsWith(`${SHARED_PACKAGE}/`)
        ) {
          violations.push({
            file: relative(REPO_ROOT, file).replace(/\\/g, "/"),
            reason: `imports ${spec.specifier}`,
          });
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `Found ${violations.length} runtime plugin boundary violation(s). Runtime plugins must not depend on ${SHARED_PACKAGE}.`,
    );
    for (const violation of violations.slice(0, 200)) {
      console.error(`${violation.file}: ${violation.reason}`);
    }
    if (violations.length > 200) {
      console.error(`...and ${violations.length - 200} more`);
    }
    process.exit(1);
  }

  console.log(`No runtime plugin imports or dependencies on ${SHARED_PACKAGE}.`);
}

main();
