/**
 * Admin AI Model Test API
 *
 * @route POST /api/admin/ai-models/test - Test AI model configuration
 * @access Admin
 *
 * @description
 * Tests the current AI model configuration with a simple completion request.
 * Verifies provider integration and model availability. Returns test response
 * and performance metrics.
 *
 * @openapi
 * /api/admin/ai-models/test:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Test AI model configuration
 *     description: Tests current AI model with simple completion (admin only)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Test completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 provider:
 *                   type: string
 *                 model:
 *                   type: string
 *                 durationMs:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Model test failed
 *
 * @example
 * ```typescript
 * const result = await fetch('/api/admin/ai-models/test', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` }
 * }).then(r => r.json());
 * ```
 */

import {
  getClientIp,
  logAdminModify,
  requireAdmin,
  withErrorHandling,
} from "@feed/api";
import { FeedLLMClient } from "@feed/engine";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * POST /api/admin/ai-models/test
 * Tests the current AI model configuration with a simple completion
 */
export const POST = withErrorHandling(async (req: NextRequest) => {
  const admin = await requireAdmin(req);

  // Initialize client (uses Groq by default for game tick operations)
  const client = FeedLLMClient.forGameTick();
  const stats = client.getStats();

  // Audit log the test
  logAdminModify({
    adminId: admin.userId,
    ipAddress: getClientIp(req.headers) ?? undefined,
    resourceType: "ai_models",
    metadata: {
      action: "test_model",
      provider: stats.provider,
      model: stats.model,
    },
  });

  logger.info(
    "Testing AI model",
    {
      provider: stats.provider,
      model: stats.model,
    },
    "AIModelsTest",
  );

  // Simple test prompt
  const testPrompt = `Generate a brief test response (max 50 chars) confirming you're working.

Return your response as XML in this exact format:
<response>
  <message>your test message here</message>
  <status>ok</status>
</response>`;

  const startTime = Date.now();

  // Make test call
  const rawResponse = await client.generateJSON<
    | { message: string; status: string }
    | { response: { message: string; status: string } }
  >(
    testPrompt,
    {
      properties: {
        message: { type: "string" },
        status: { type: "string" },
      },
      required: ["message", "status"],
    },
    {
      temperature: 0.7,
      maxTokens: 100,
      promptType: "admin_test_ai_model",
    },
  );

  // Handle XML structure
  const response =
    "response" in rawResponse && rawResponse.response
      ? rawResponse.response
      : (rawResponse as { message: string; status: string });

  const latency = Date.now() - startTime;

  logger.info(
    "AI model test successful",
    {
      provider: stats.provider,
      model: stats.model,
      latency,
      response,
    },
    "AIModelsTest",
  );

  return NextResponse.json({
    success: true,
    data: {
      provider: stats.provider,
      model: stats.model,
      response: response,
      latency,
      timestamp: new Date().toISOString(),
    },
    message: `Successfully tested ${stats.provider} (model: ${stats.model})`,
  });
});
