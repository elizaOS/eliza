// zlib-sync stub for the mobile agent bundle.
//
// zlib-sync is a native Node binding pulled in by discord.js for compressed
// gateway frames. The bun mobile bundle ships no x64 / arm64 prebuild for
// AOSP bionic, so the static `require("./build/Release/zlib_sync.node")`
// at the top of the package's index.js fails Bun.build. discord.js falls
// back to uncompressed transport when the binding throws, so this stub
// keeps the bundle building without breaking the runtime.
"use strict";

function unavailable() {
  throw new Error(
    "zlib-sync is not available in the AOSP agent bundle — falling back to uncompressed transport",
  );
}

module.exports = {
  __mobileStub: true,
  Inflate: unavailable,
  Deflate: unavailable,
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_TREES: 6,
};
