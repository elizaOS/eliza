/**
 * Types for assert-package-boundary-imports.mjs so the vitest guard test can
 * import the walker under typecheck.
 */

export interface CrossPackageImportViolation {
	file: string;
	line: number;
	specifier: string;
}

export declare const agentPackageRoot: string;

export declare function findCrossPackageImports(
	packageRoot?: string,
): CrossPackageImportViolation[];
