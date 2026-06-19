// Typecheck-only stand-in for dynamic `@elizaos/app-core` imports pulled in
// through source path mappings. The dynamic import sites cast the module shape
// explicitly and should not depend on generated app-core dist during this
// package's typecheck.
export {};
