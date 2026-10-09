// canvas stub for the mobile agent bundle.
"use strict";

const NOT_AVAILABLE_MSG =
  "canvas is not available in the Android mobile bundle";

function unavailable() {
  throw new Error(NOT_AVAILABLE_MSG);
}

module.exports = {
  __mobileStub: true,
  createCanvas: unavailable,
  loadImage: unavailable,
  Canvas: class {
    constructor() {
      unavailable();
    }
  },
  Image: class {
    constructor() {
      unavailable();
    }
  },
};
