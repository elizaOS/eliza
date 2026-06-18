// vitest resolution stub for an @elizaos/ui glue subpath the Vector Browser
// view imports. The package `exports` map does not resolve these specifiers
// under vitest (directory-index subpaths + dist/source condition mismatch), so
// the plugin vitest config aliases each one to a distinct stub here. The real
// test behavior is provided by vi.mock(...) factories keyed on the original
// specifier; nothing in this file is executed at runtime.
export {};
