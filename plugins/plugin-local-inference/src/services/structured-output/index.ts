// Node.js ESM can't resolve extensionless directory imports without an index
// file. Re-export everything from the parent module; rewriteRelativeImportExtensions
// rewrites the `.ts` suffix to `.js` in the compiled output so the runtime finds it.
export * from "../structured-output.ts";
