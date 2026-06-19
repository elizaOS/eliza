// @node-rs/argon2 stub for the Android mobile agent bundle.
//
// The native package emits a host-specific `.node` binary during Bun.build.
// That is unusable on Android and must never be staged into `dist-mobile`.
// Mobile does not run the desktop password-auth endpoints; if a route reaches
// this surface, fail closed instead of silently accepting a password.
"use strict";

const NOT_AVAILABLE_MSG =
  "@node-rs/argon2 is not available in the Android mobile agent bundle";

async function unavailable() {
  throw new Error(NOT_AVAILABLE_MSG);
}

module.exports = {
  Algorithm: {
    Argon2d: 0,
    Argon2i: 1,
    Argon2id: 2,
  },
  hash: unavailable,
  verify: unavailable,
};
