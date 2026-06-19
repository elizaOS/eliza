import { withErrorHandling } from "@feed/api";
import { NextResponse } from "next/server";

function notFoundResponse() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export const GET = withErrorHandling(notFoundResponse);
export const POST = withErrorHandling(notFoundResponse);
export const PUT = withErrorHandling(notFoundResponse);
export const PATCH = withErrorHandling(notFoundResponse);
export const DELETE = withErrorHandling(notFoundResponse);
export const OPTIONS = withErrorHandling(notFoundResponse);
