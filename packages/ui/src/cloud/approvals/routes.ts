import { lazy } from "react";
import {
  type CloudRouteDef,
  registerCloudRoute,
} from "../shell/cloud-route-registry";

export const APPROVALS_ROUTE_PATH = "cloud/approvals";

const ApprovalsRouteLazy = lazy(() => import("./ApprovalsRoute"));

export const approvalsCloudRoute: CloudRouteDef = {
  path: APPROVALS_ROUTE_PATH,
  element: ApprovalsRouteLazy,
  group: "cloud",
};

export function registerApprovalsCloudRoute(
  override?: Partial<CloudRouteDef>,
): void {
  registerCloudRoute({ ...approvalsCloudRoute, ...override });
}

registerApprovalsCloudRoute();
