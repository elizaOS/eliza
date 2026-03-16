import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { charactersService } from "@/lib/services/characters";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/my-agents/characters/[id]
 * Get a specific character by ID.
 * Supports both Privy session and API key authentication.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const character = await charactersService.getByIdForUser(id, user.id);

  if (!character) {
    return NextResponse.json(
      { success: false, error: "Character not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, data: { character } });
}

/**
 * DELETE /api/my-agents/characters/[id]
 * Delete a character owned by the user.
 * Supports both Privy session and API key authentication.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  logger.info("[My Agents API] Deleting character:", {
    characterId: id,
    userId: user.id,
  });

  // Verify ownership first
  const character = await charactersService.getByIdForUser(id, user.id);
  if (!character) {
    return NextResponse.json(
      { success: false, error: "Character not found or access denied" },
      { status: 404 },
    );
  }

  await charactersService.delete(id);

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/my-agents");

  return NextResponse.json({
    success: true,
    data: { message: "Character deleted successfully" },
  });
}
