/** Factory parameter name the wrapped bundle resolves host externals through. */
export declare const HOST_IMPORT_PARAM: "__elizaHostImport";

export declare function convertNamedImportsToDestructuring(
  namedImports: string,
): string;

export declare function buildHostExternalImportReplacement(
  importClause: string,
  specifier: string,
  index: number,
): string;

export declare function wrapBundleAsHostExternalFactory(
  source: string,
  specifiers: readonly string[],
): string;

export declare function parseHostExternalSpecifiers(url: URL): string[];
