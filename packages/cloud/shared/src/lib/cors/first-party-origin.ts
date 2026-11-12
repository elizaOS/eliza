/**
 * Defines the Cloud browser origins allowed to use cookie or native
 * credentials across the API and dedicated-agent router boundaries. The
 * web origins come from the Cloud deployment; an incomplete product
 * deployment throws rather than admitting another deployment's origins.
 */

import {
  APP_SCHEME_ORIGIN_RE,
  CAPACITOR_WEBVIEW_ORIGIN,
  isLocalDevLoopbackOrigin,
} from "../cors-constants";
import { getCloudDeployment } from "../deployment/cloud-deployment";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";

/** Whether an origin may receive credentialed browser responses. */
export function isFirstPartyOrigin(origin: string): boolean {
  if (getCloudDeployment().firstPartyOrigins.has(origin)) return true;
  if (origin === CAPACITOR_WEBVIEW_ORIGIN || APP_SCHEME_ORIGIN_RE.test(origin)) {
    return true;
  }
  if (isLocalDevLoopbackOrigin(origin)) {
    return getCloudAwareEnv().ENVIRONMENT !== "production";
  }
  return false;
}
