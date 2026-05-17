// puppeteer-core stub for the mobile agent bundle.
//
// Browser automation is not part of the mobile-agent feature set. The agent's
// `services/browser-capture.ts` is invoked only via the desktop UI and an
// explicit user action; on mobile that route never runs.
"use strict";

const NOT_AVAILABLE_MSG =
  "puppeteer-core is not available in the Android mobile bundle";

function unavailable() {
  throw new Error(NOT_AVAILABLE_MSG);
}

const launch = unavailable;
const connect = unavailable;

module.exports = {
  __mobileStub: true,
  launch,
  connect,
  default: { launch, connect },
};
