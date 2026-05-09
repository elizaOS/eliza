// empty.cjs — used by the mobile bundle to stub CSS imports.
// The agent never renders pixels on-device; CSS pulled transitively
// through `@elizaos/ui/capacitor-shell` and similar UI modules has no
// runtime effect.
"use strict";
module.exports = {};
