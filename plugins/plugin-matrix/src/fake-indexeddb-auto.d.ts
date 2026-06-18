// fake-indexeddb's package.json maps the "./auto" subpath without a `types`
// field, so under bundler module resolution TypeScript can't locate its bundled
// declaration. service.ts imports it only for its side effect (it installs the
// global IndexedDB constructors so the rust-crypto store can persist under
// Node/Bun), so a bare ambient declaration is all that's needed.
declare module "fake-indexeddb/auto";
