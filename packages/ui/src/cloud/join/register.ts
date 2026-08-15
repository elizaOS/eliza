/**
 * Cloud-route registration for the join domain.
 *
 * Registers `/join` — the post-login landing that provisions/connects a Cloud
 * agent and drops the user into chat (the headline migration outcome). The route
 * is authenticated (NOT `public`): it needs the Steward runtime so the session
 * resolves; signed-out visitors are bounced to `/login?returnTo=/join` by the
 * page itself.
 *
 * Importing this module is the single side-effecting entry point: the app shell
 * imports `registerJoinFlow` once at boot, after which `listCloudRoutes()`
 * includes the join route.
 */

import { lazy } from "react";
import { registerCloudRoute } from "../shell/cloud-route-registry";

export const JOIN_ROUTE_PATH = "join";
export const GET_STARTED_ROUTE_PATH = "get-started";

const JoinPage = lazy(() => import("./JoinPage"));
const GetStartedPage = lazy(() => import("./GetStartedPage"));

let registered = false;

/** Register the join routes. Idempotent — safe to call more than once. */
export function registerJoinFlow(): void {
  if (registered) return;
  registered = true;
  registerCloudRoute({
    path: JOIN_ROUTE_PATH,
    element: JoinPage,
    group: "auth",
  });
  // The messaging-funnel continuation landing (`?onboardingSession=`).
  // Authenticated like /join: the page itself bounces signed-out visitors to
  // /login after persisting the continuation token.
  registerCloudRoute({
    path: GET_STARTED_ROUTE_PATH,
    element: GetStartedPage,
    group: "auth",
  });
}
