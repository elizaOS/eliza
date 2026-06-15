export { createOwnerSendPolicy } from "./owner-send-policy.js";

// LifeOps owns owner send policy. Message transport adapters stay exported by
// their connector plugins and are registered from those packages in plugin.ts.
