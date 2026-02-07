/**
 * Agent List API
 *
 * GET /api/my-agents/characters
 * Lists user's own agents/characters with filtering and sorting.
 * Supports both Privy session and API key authentication.
 *
 * WHY API KEY SUPPORT:
 * --------------------
 * 1. PROGRAMMATIC AGENT MANAGEMENT: Developers need to list their agents from scripts,
 *    CI/CD pipelines, and external systems without browser-based auth flows.
 *
 * 2. AGENT ORCHESTRATION: Meta-agents (agents that manage other agents) need to
 *    discover and interact with their fleet of specialized agents.
 *
 * 3. DASHBOARD INTEGRATIONS: External dashboards and monitoring tools need to
 *    display agent inventories without requiring Privy session cookies.
 *
 * 4. MULTI-TENANT PLATFORMS: Platforms built on elizaOS Cloud can manage agents
 *    on behalf of their users via API keys.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { charactersService } from "@/lib/services/characters";
import { logger } from "@/lib/utils/logger";
import type { CategoryId, SortBy, SortOrder } from "@/lib/types/my-agents";

export const dynamic = "force-dynamic";

/**
 * GET /api/my-agents/characters
 * Lists user's own characters with filtering and sorting.
 *
 * @param request - Request with query parameters for search, filters, sorting, and pagination.
 * @returns Paginated character results.
 */
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { searchParams } = new URL(request.url);

    // Parse search filters
    const search = searchParams.get("search") || undefined;
    const category = searchParams.get("category") as CategoryId | undefined;

    // Sort options
    const sortBy = (searchParams.get("sortBy") || "newest") as SortBy;
    const order = (searchParams.get("order") || "desc") as SortOrder;

    // Pagination
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(
      1000,
      Math.max(1, parseInt(searchParams.get("limit") || "30", 10)),
    );

    logger.debug("[My Agents API] Search request:", {
      userId: user.id,
      organizationId: user.organization_id,
      search,
      category,
      sortBy,
      page,
      limit,
    });

    // Get user's characters
    let characters = await charactersService.listByUser(user.id);

    // Apply search filter
    if (search) {
      const query = search.toLowerCase();
      characters = characters.filter(
        (char) =>
          char.name.toLowerCase().includes(query) ||
          (typeof char.bio === "string" &&
            char.bio.toLowerCase().includes(query)) ||
          (Array.isArray(char.bio) &&
            char.bio.some((b) => b.toLowerCase().includes(query))),
      );
    }

    // Apply category filter
    if (category) {
      characters = characters.filter((char) => char.category === category);
    }

    // Sort characters
    characters.sort((a, b) => {
      switch (sortBy) {
        case "name": {
          const result = a.name.localeCompare(b.name);
          return order === "desc" ? -result : result;
        }
        case "newest": {
          const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
          const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
          // Descending: newest first (higher timestamp first)
          return order === "desc" ? dateB - dateA : dateA - dateB;
        }
        case "updated": {
          const updA = a.updated_at ? new Date(a.updated_at).getTime() : 0;
          const updB = b.updated_at ? new Date(b.updated_at).getTime() : 0;
          // Descending: most recently updated first (higher timestamp first)
          return order === "desc" ? updB - updA : updA - updB;
        }
        default:
          return 0;
      }
    });

    // Apply pagination
    const totalCount = characters.length;
    const totalPages = Math.ceil(totalCount / limit);
    const offset = (page - 1) * limit;
    const paginatedCharacters = characters.slice(offset, offset + limit);

    return NextResponse.json({
      success: true,
      data: {
        characters: paginatedCharacters.map((char) => ({
          id: char.id,
          name: char.name,
          bio: char.bio,
          avatarUrl: char.avatar_url,
          avatar_url: char.avatar_url,
          category: char.category,
          isPublic: char.is_public,
          is_public: char.is_public,
          createdAt: char.created_at,
          created_at: char.created_at,
          updatedAt: char.updated_at,
          updated_at: char.updated_at,
          tags: char.tags,
        })),
        pagination: {
          page,
          limit,
          totalPages,
          totalCount,
          hasMore: page < totalPages,
        },
      },
    });
  } catch (error) {
    logger.error("[My Agents API] Error searching characters:", error);

    const status =
      error instanceof Error && error.message.includes("auth") ? 401 : 500;

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to search characters",
      },
      { status },
    );
  }
}
