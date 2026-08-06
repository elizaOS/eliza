import { NextRequest, NextResponse } from "next/server";
import { getShare, revokeShare, verifySharePassword } from "@/lib/share-store";

interface RouteContext {
  params: { shareId: string };
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  const { shareId } = params;
  const share = getShare(shareId);

  if (!share) {
    return NextResponse.json({ error: "Share not found or expired" }, { status: 404 });
  }

  if (share.visibility === "password") {
    const pw = req.headers.get("x-share-password") ?? req.nextUrl.searchParams.get("password");
    if (!pw || !verifySharePassword(shareId, pw)) {
      return NextResponse.json({ error: "Password required", requiresPassword: true }, { status: 401 });
    }
  }

  return NextResponse.json({
    id: share.id,
    title: share.conversation.title,
    messages: share.conversation.messages,
    model: share.conversation.model,
    createdAt: share.conversation.createdAt,
    shareCreatedAt: share.createdAt,
  });
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  const { shareId } = params;
  const deleted = revokeShare(shareId);

  if (!deleted) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
