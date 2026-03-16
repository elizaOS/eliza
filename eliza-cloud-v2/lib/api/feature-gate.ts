import { NextResponse } from "next/server";
import {
  isFeatureEnabled,
  getFeatureForRoute,
  type FeatureFlag,
} from "@/lib/config/feature-flags";

export function requireFeature(flag: FeatureFlag): NextResponse | null {
  if (!isFeatureEnabled(flag)) {
    return NextResponse.json(
      { success: false, error: "Feature not available" },
      { status: 404 },
    );
  }
  return null;
}

export function checkRouteFeature(pathname: string): NextResponse | null {
  const feature = getFeatureForRoute(pathname);
  if (feature && !isFeatureEnabled(feature)) {
    return NextResponse.json(
      { success: false, error: "Feature not available" },
      { status: 404 },
    );
  }
  return null;
}
