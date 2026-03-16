import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { generationsService } from "@/lib/services/generations";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/gallery
 * Lists all media (images and videos) for the authenticated user's organization.
 * Supports filtering by type and pagination.
 *
 * @param request - Request with optional type, limit, and offset query parameters.
 * @returns Paginated list of gallery items with metadata.
 */
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);

    const searchParams = request.nextUrl.searchParams;
    const type = searchParams.get("type") as "image" | "video" | null;
    const limit = Math.min(parseInt(searchParams.get("limit") || "100"), 1000);
    const offset = parseInt(searchParams.get("offset") || "0");

    // Fetch with database-level filtering for performance
    const allGenerations = await generationsService.listByOrganizationAndStatus(
      user.organization_id!,
      "completed",
      {
        userId: user.id,
        type: type || undefined,
        limit: limit,
        offset: offset,
      },
    );

    // Filter out generations without storage_url
    const generations = allGenerations.filter((gen) => gen.storage_url);

    const items = generations.map((gen) => ({
      id: gen.id,
      type: gen.type,
      url: gen.storage_url,
      thumbnailUrl: gen.thumbnail_url,
      prompt: gen.prompt,
      negativePrompt: gen.negative_prompt,
      model: gen.model,
      provider: gen.provider,
      status: gen.status,
      createdAt: gen.created_at.toISOString(),
      completedAt: gen.completed_at?.toISOString(),
      dimensions: gen.dimensions,
      mimeType: gen.mime_type,
      fileSize: gen.file_size?.toString(),
      metadata: gen.metadata,
    }));

    return NextResponse.json(
      {
        items,
        count: items.length,
        offset,
        limit,
        hasMore: items.length === limit,
      },
      { status: 200 },
    );
  } catch (error) {
    logger.error("[GALLERY API] Error:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Failed to fetch gallery items";

    return NextResponse.json(
      { error: errorMessage },
      {
        status:
          error instanceof Error &&
          (error.message.includes("API key") ||
            error.message.includes("Forbidden"))
            ? 401
            : 500,
      },
    );
  }
}
