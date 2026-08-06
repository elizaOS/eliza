import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import type { Conversation } from "@/lib/types";
import type { ShareVisibility, ShareExpiry } from "@/lib/share-store";
import { createShare } from "@/lib/share-store";

interface CreateShareRequest {
  conversation: Conversation;
  visibility: ShareVisibility;
  password?: string;
  expiry: ShareExpiry;
}

export async function POST(req: NextRequest) {
  let body: CreateShareRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { conversation, visibility, password, expiry } = body;
  if (!conversation || !visibility || !expiry) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  if (visibility === "password" && !password) {
    return NextResponse.json(
      { error: "Password required for password-protected shares" },
      { status: 400 }
    );
  }

  const shareId = nanoid(12);
  const share = createShare(shareId, { conversation, visibility, password, expiry });

  const origin = req.headers.get("origin") ?? "";
  const url = `${origin}/share/${shareId}`;

  return NextResponse.json({
    id: share.id,
    conversationId: share.conversationId,
    visibility: share.visibility,
    hasPassword: !!share.passwordHash,
    expiry: share.expiry,
    expiresAt: share.expiresAt,
    createdAt: share.createdAt,
    url,
  });
}
