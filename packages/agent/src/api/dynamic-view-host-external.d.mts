/** globalThis hook the rewritten imports call to resolve a host-external module. */
export declare const DYNAMIC_VIEW_IMPORT_GLOBAL: "__ELIZA_DYNAMIC_VIEW_IMPORT__";

export declare function convertNamedImportsToDestructuring(
  namedImports: string,
): string;

export declare function buildHostExternalImportReplacement(
  importClause: string,
  specifier: string,
  index: number,
): string;

export declare function rewriteHostExternalImports(
  source: string,
  specifiers: readonly string[],
): string;

export declare function parseHostExternalSpecifiers(url: URL): string[];
