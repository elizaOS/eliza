import { type FeatureFlag, getFeatureForRoute, isFeatureEnabled } from "@/lib/config/feature-flags";

export function requireFeature(flag: FeatureFlag): Response | null {
  if (!isFeatureEnabled(flag)) {
    return Response.json({ success: false, error: "Feature not available" }, { status: 404 });
  }
  return null;
}

export function checkRouteFeature(pathname: string): Response | null {
  const feature = getFeatureForRoute(pathname);
  if (feature && !isFeatureEnabled(feature)) {
    return Response.json({ success: false, error: "Feature not available" }, { status: 404 });
  }
  return null;
}
