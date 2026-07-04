/**
 * Host-external view-bundle factory transform — single source of truth.
 *
 * A plugin view bundle is built with `@elizaos/ui`, `react`, three, … left as
 * *external* bare imports. Those specifiers must resolve to the host shell's own
 * singletons (one React instance, the live app-core client, plugins registered
 * at runtime), not to a second copy the browser fetches on its own. A separately
 * imported ES module cannot reach the shell's live modules by itself, so at
 * serve time the bundle is wrapped into a **factory**: its bare host-external
 * imports become bindings resolved from an injected `hostImport(specifier)`
 * function, and its trailing `export { … }` list becomes the factory's return
 * namespace. The shell's `DynamicViewLoader` imports the wrapped module, calls
 * the default-exported factory with a `hostImport` closure backed by its
 * host-external importer map, and gets the view namespace back — sharing the
 * host realm without any `globalThis` bridge or import-map indirection.
 *
 * Both the agent bundle route (`views-routes.ts`) and the Playwright UI-smoke
 * stub (`playwright-ui-smoke-api-stub.mjs`) apply the identical transform, so it
 * lives here once. Plain ESM (no deps, no build step) so the node-run smoke stub
 * can import it directly by path while the agent bundles it normally. The typed
 * factory/importer contract lives in `@elizaos/shared` (`src/views/
 * host-external-contract.ts`); this module is its runtime implementation.
 *
 * The transform relies on the fixed shape the view-bundle build emits (single
 * self-contained ES module, host externals as bare top-level imports, every
 * export collected into one trailing `export { … }` list — see
 * `view-bundle-vite.config.ts` and `view-bundle-single-chunk.test.ts`).
 */

/** Factory parameter name the wrapped bundle resolves host externals through. */
export const HOST_IMPORT_PARAM = "__elizaHostImport";

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
 * Build the binding statements that replace one host-external `import` clause,
 * resolving the module through the injected `hostImport` factory parameter.
 *
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
    `const ${moduleVar} = await ${HOST_IMPORT_PARAM}(${JSON.stringify(specifier)});`,
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
 * Replace every bare `import … from "<specifier>"` (and side-effect
 * `import "<specifier>"`) whose specifier is host-external with bindings that
 * resolve the module through the injected `hostImport` parameter.
 *
 * @param {string} source
 * @param {readonly string[]} specifiers
 * @returns {string}
 */
function bindHostExternalImports(source, specifiers) {
  if (specifiers.length === 0) return source;
  const specifierPattern = specifiers
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  // `import` is followed by whitespace before a bare default identifier, but by
  // no whitespace at all when the clause starts with `{`/`*` or the specifier
  // quote (minified `import{x}from"y"` / `import"y"`). Match both so the
  // transform holds whether the view bundle ships minified or not.
  const afterImport = `(?:\\s+|(?=[{*"']))`;
  const fromImportPattern = new RegExp(
    `import${afterImport}([^;]*?)\\s*from\\s*["'](${specifierPattern})["'];?`,
    "gu",
  );
  const sideEffectPattern = new RegExp(
    `import${afterImport}["'](${specifierPattern})["'];?`,
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
        `await ${HOST_IMPORT_PARAM}(${JSON.stringify(String(specifier))});`,
    );
}

/** One `<local> as <exported>` (or bare `<local>`) entry of an export list. */
function parseExportEntry(entry) {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const asMatch = trimmed.match(/^([\S]+)\s+as\s+(.+)$/u);
  if (asMatch) {
    const exported = asMatch[2].trim().replace(/^["']|["']$/gu, "");
    return { local: asMatch[1].trim(), exported };
  }
  return { local: trimmed, exported: trimmed };
}

/**
 * Convert the bundle's single trailing `export { a as X, b as default }` list
 * into a `return { X: a, default: b }` object and strip the `export` keyword.
 * The view-bundle build always collects every export into one trailing list, so
 * a body with no such list simply returns an empty namespace.
 *
 * @param {string} source
 * @returns {string}
 */
function collectTrailingExports(source) {
  const exportListPattern = /export\s*\{([\s\S]*?)\}\s*;?/gu;
  const entries = [];
  const body = source.replace(exportListPattern, (_match, inner) => {
    for (const raw of String(inner).split(",")) {
      const parsed = parseExportEntry(raw);
      if (parsed) entries.push(parsed);
    }
    return "";
  });
  const namespace = entries
    .map(({ local, exported }) => `${JSON.stringify(exported)}: ${local}`)
    .join(", ");
  return `${body}\nreturn { ${namespace} };\n`;
}

/**
 * Wrap a served view bundle as a host-external factory module: bind its
 * host-external imports to an injected `hostImport` parameter and return its
 * exports as a namespace. The module's sole export is a default async factory
 * matching the `HostExternalBundleFactory` contract in `@elizaos/shared`.
 *
 * @param {string} source
 * @param {readonly string[]} specifiers
 * @returns {string}
 */
export function wrapBundleAsHostExternalFactory(source, specifiers) {
  const bound = bindHostExternalImports(source, specifiers);
  const factoryBody = collectTrailingExports(bound);
  return (
    `export default async function ${HOST_IMPORT_PARAM}Factory(${HOST_IMPORT_PARAM}) {\n` +
    `${factoryBody}}\n`
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
