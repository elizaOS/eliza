/** Dedicated packaged native-host executable entrypoint; never starts Electrobun UI. */

import {
  browserBridgeCallerAllowlistFromEnv,
  resolveNativeHostInvocation,
  runBrowserBridgeNativeHostStdio,
} from "./browser-bridge-native-host-entry";

const allowlist = browserBridgeCallerAllowlistFromEnv();
const caller = resolveNativeHostInvocation(process.argv, allowlist);
if (!caller) {
  process.exitCode = 1;
} else {
  await runBrowserBridgeNativeHostStdio({
    caller,
    allowlist,
    windowsUserSid: process.env.ELIZA_WINDOWS_USER_SID,
  });
}
