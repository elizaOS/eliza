import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKey } from "@/lib/auth";
import { getECRManager } from "@/lib/services/ecr";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/containers/credentials
 * Requests ECR repository and authentication token for building and pushing Docker images.
 * Provides temporary ECR credentials for the CLI to push Docker images.
 * Rate limited: 10 requests per minute.
 *
 * @param request - Request body with projectId and version.
 * @returns ECR repository URI, image URI, authentication token, and registry endpoint.
 */
async function handleECRCredentials(request: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKey(request);
    const body = await request.json();

    // Validate request
    const { projectId, version } = body;

    if (!projectId || !version) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required fields: projectId, version",
        },
        { status: 400 },
      );
    }

    // Initialize ECR manager
    const ecrManager = getECRManager();

    // Generate ECR repository name
    const repositoryName =
      `elizaos/${user.organization_id}/${projectId}`.toLowerCase();

    // Create or get ECR repository
    const repository = await ecrManager.createRepository(repositoryName);

    // Get ECR authorization token
    const authData = await ecrManager.getAuthorizationToken();

    // Generate image tag
    const imageTag = `${version}-${Date.now()}`;
    const imageUri = ecrManager.getImageUri(repository.repositoryUri, imageTag);

    // Return ECR credentials and repository information
    return NextResponse.json({
      success: true,
      data: {
        ecrRepositoryUri: repository.repositoryUri,
        ecrImageUri: imageUri,
        ecrImageTag: imageTag,
        authToken: authData.authorizationToken!,
        authTokenExpiresAt: authData.expiresAt?.toISOString(),
        registryEndpoint: authData.proxyEndpoint!,
      },
    });
  } catch (error) {
    logger.error("Error getting ECR credentials:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get ECR credentials",
      },
      { status: 500 },
    );
  }
}

// Export rate-limited handler
export const POST = withRateLimit(
  handleECRCredentials,
  RateLimitPresets.STRICT,
);
