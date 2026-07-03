/**
 * Host-external view-import rewrite — single source of truth.
 *
 * A plugin view bundle is built with `@elizaos/ui`, `react`, three, … left as
 * *external* bare imports. At serve time the bare imports are rewritten into
 * `globalThis.__ELIZA_DYNAMIC_VIEW_IMPORT__("<specifier>")` calls that
 * `DynamicViewLoader` resolves against its `HOST_EXTERNAL_IMPORTERS` map, so the
 * view shares the host's singletons instead of loading a second copy.
 *
 * Both the agent bundle route (`views-routes.ts`) and the Playwright UI-smoke
 * stub (`playwright-ui-smoke-api-stub.mjs`) must apply the identical transform,
 * so it lives here once. Plain ESM (no deps, no build step) so the node-run
 * smoke stub can import it directly by path while the agent bundles it normally.
 *
 * NOTE: this is the legacy `globalThis`-hook transform; replacing it with a
 * native import map is tracked separately (arch-audit #12091 item 13).
 */

/** globalThis hook the rewritten imports call to resolve a host-external module. */
export const DYNAMIC_VIEW_IMPORT_GLOBAL = "__ELIZA_DYNAMIC_VIEW_IMPORT__";

/** @param {string} namedImports @returns {string} */
export function convertNamedImportsToDestructuring(namedImports) {
  return namedImports
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/\s+as\s+/u, ": "))
    .join(", ");
}

/**
 * @param {string} importClause
 * @param {string} specifier
 * @param {number} index
 * @returns {string}
 */
export function buildHostExternalImportReplacement(
  importClause,
  specifier,
  index,
) {
  const moduleVar = `__eliza_dynamic_view_host_external_${index}`;
  const lines = [
    `const ${moduleVar} = await globalThis.${DYNAMIC_VIEW_IMPORT_GLOBAL}(${JSON.stringify(specifier)});`,
  ];
  const trimmed = importClause.trim();
  if (trimmed.startsWith("* as ")) {
    lines.push(`const ${trimmed.slice("* as ".length).trim()} = ${moduleVar};`);
    return lines.join("\n");
  }

  const namedMatch = trimmed.match(/^\{([\s\S]*)\}$/u);
  if (namedMatch) {
    lines.push(
      `const { ${convertNamedImportsToDestructuring(namedMatch[1])} } = ${moduleVar};`,
    );
    return lines.join("\n");
  }

  const defaultAndNamedMatch = trimmed.match(/^([^,]+),\s*\{([\s\S]*)\}$/u);
  if (defaultAndNamedMatch) {
    lines.push(
      `const ${defaultAndNamedMatch[1].trim()} = ${moduleVar}.default ?? ${moduleVar};`,
    );
    lines.push(
      `const { ${convertNamedImportsToDestructuring(defaultAndNamedMatch[2])} } = ${moduleVar};`,
    );
    return lines.join("\n");
  }

  lines.push(`const ${trimmed} = ${moduleVar}.default ?? ${moduleVar};`);
  return lines.join("\n");
}

/**
 * Rewrite every bare `import … from "<specifier>"` (and side-effect
 * `import "<specifier>"`) whose specifier is host-external into a
 * `globalThis.__ELIZA_DYNAMIC_VIEW_IMPORT__` call.
 *
 * @param {string} source
 * @param {readonly string[]} specifiers
 * @returns {string}
 */
export function rewriteHostExternalImports(source, specifiers) {
  if (specifiers.length === 0) return source;
  const specifierPattern = specifiers
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const fromImportPattern = new RegExp(
    `import\\s+([^;]*?)\\s+from\\s+["'](${specifierPattern})["'];?`,
    "gu",
  );
  const sideEffectPattern = new RegExp(
    `import\\s+["'](${specifierPattern})["'];?`,
    "gu",
  );
  let replacementIndex = 0;

  return source
    .replace(fromImportPattern, (_match, importClause, specifier) =>
      buildHostExternalImportReplacement(
        String(importClause),
        String(specifier),
        replacementIndex++,
      ),
    )
    .replace(
      sideEffectPattern,
      (_match, specifier) =>
        `await globalThis.${DYNAMIC_VIEW_IMPORT_GLOBAL}(${JSON.stringify(String(specifier))});`,
    );
}

/**
 * Read the host-external specifier list off a served-bundle request URL. The
 * loader sends it (`hostExternalSpecifiers`) alongside `hostExternalRuntime=1`.
 *
 * @param {URL} url
 * @returns {string[]}
 */
export function parseHostExternalSpecifiers(url) {
  if (url.searchParams.get("hostExternalRuntime") !== "1") return [];
  return (url.searchParams.get("hostExternalSpecifiers") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
