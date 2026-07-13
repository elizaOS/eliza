// Pepr 1.2 and @typescript-eslint still load the legacy `typescript` compiler
// API. TypeScript 7 intentionally exports only version metadata from that
// package root, so redirect those tooling-only loads to Microsoft's supported
// TypeScript 6 compatibility package. This hook is scoped to the Pepr child
// process by scripts/build.mjs; the repository compiler remains TypeScript 7.
const Module = require("node:module");
const legacyTypeScript = require("@typescript/legacy-api");

const load = Module._load;
Module._load = function loadWithLegacyTypeScript(request, parent, isMain) {
  if (request === "typescript") {
    return legacyTypeScript;
  }
  return Reflect.apply(load, this, [request, parent, isMain]);
};
