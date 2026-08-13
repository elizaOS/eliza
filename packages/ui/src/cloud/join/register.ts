/**
 * Cloud-route registration for the join domain.
 *
 * Registers the private `/join` provisioning flow and the reviewed public
 * `/get-started` consent boundary. The latter must render without Steward so a
 * stored account token cannot trigger session sync before explicit consent.
 *
 * Importing this module is the single side-effecting entry point: the app shell
 * imports `registerJoinFlow` once at boot, after which `listCloudRoutes()`
 * includes the join route.
 */

import { lazy } from "react";
import {
  CLOUD_PUBLIC_ROUTE_ACCESS,
  registerCloudRoute,
} from "../shell/cloud-route-registry";

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
  // Identity-agnostic and transport-free: keeping this route public prevents
  // Steward session sync until the user explicitly enters private `/join`.
  registerCloudRoute({
    path: GET_STARTED_ROUTE_PATH,
    element: GetStartedPage,
    group: "auth",
    public: true,
    publicAccess: CLOUD_PUBLIC_ROUTE_ACCESS,
  });
}
