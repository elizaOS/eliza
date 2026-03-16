import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { aiAppBuilder } from "@/lib/services/ai-app-builder";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { sessionId } = await params;
    const session = await aiAppBuilder.getSession(sessionId, user.id);

    if (!session) {
      return NextResponse.json(
        { success: false, error: "Session not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, session });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to get session";
    const status =
      message.includes("Unauthorized") || message.includes("Authentication")
        ? 401
        : message.includes("Access denied") || message.includes("don't own")
          ? 403
          : message.includes("not found")
            ? 404
            : 500;

    return NextResponse.json({ success: false, error: message }, { status });
  }
}

const ExtendSessionSchema = z.object({
  durationMs: z.number().min(60000).max(3600000).default(900000),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { sessionId } = await params;

    const body = await request.json();
    const validationResult = ExtendSessionSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request data",
          details: validationResult.error.format(),
        },
        { status: 400 },
      );
    }

    const result = await aiAppBuilder.extendSession(
      sessionId,
      user.id,
      validationResult.data.durationMs,
    );

    return NextResponse.json({
      success: true,
      message: "Session extended successfully",
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to extend session";
    const status =
      message.includes("Unauthorized") || message.includes("Authentication")
        ? 401
        : message.includes("Access denied") || message.includes("don't own")
          ? 403
          : message.includes("not found")
            ? 404
            : 500;

    return NextResponse.json({ success: false, error: message }, { status });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { sessionId } = await params;

    await aiAppBuilder.stopSession(sessionId, user.id);

    return NextResponse.json({
      success: true,
      message: "Session stopped successfully",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to stop session";
    const status =
      message.includes("Unauthorized") || message.includes("Authentication")
        ? 401
        : message.includes("Access denied") || message.includes("don't own")
          ? 403
          : message.includes("not found")
            ? 404
            : 500;

    return NextResponse.json({ success: false, error: message }, { status });
  }
}
