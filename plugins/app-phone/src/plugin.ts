/**
 * elizaOS runtime plugin for the Phone app — exposes PLACE_CALL and
 * READ_CALL_LOG actions, both gated to the Phone app's session.
 */

import type { Plugin } from "@elizaos/core";
import { placeCallAction } from "./actions/place-call";
import { readCallLogAction } from "./actions/read-call-log";

const PHONE_APP_NAME = "@elizaos/app-phone";

export const appPhonePlugin: Plugin = {
  name: PHONE_APP_NAME,
  description:
    "Phone overlay: Android dialer, recent-calls, and contact-driven calls. " +
    "Actions apply only while the Phone app session is active.",
  actions: [placeCallAction, readCallLogAction],
};

export default appPhonePlugin;

export { placeCallAction } from "./actions/place-call";
export { readCallLogAction } from "./actions/read-call-log";
