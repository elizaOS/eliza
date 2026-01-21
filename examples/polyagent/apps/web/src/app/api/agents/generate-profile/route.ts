/**
 * Agent Profile Generation API
 *
 * @route POST /api/agents/generate-profile - Generate agent profile
 * @access Authenticated
 *
 * @description
 * Generates a complete agent profile based on a selected archetype and user context.
 * Uses AI to create name, description, system prompt, bio points, personality, and
 * trading strategy tailored to the archetype characteristics.
 *
 * @openapi
 * /api/agents/generate-profile:
 *   post:
 *     tags:
 *       - Agents
 *     summary: Generate agent profile
 *     description: Generates complete agent profile from archetype using AI
 *     security:
 *       - PrivyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - archetype
 *             properties:
 *               archetype:
 *                 type: object
 *                 required:
 *                   - id
 *                   - name
 *                   - description
 *                 properties:
 *                   id:
 *                     type: string
 *                   name:
 *                     type: string
 *                   emoji:
 *                     type: string
 *                   description:
 *                     type: string
 *               userProfile:
 *                 type: object
 *                 description: Optional user context
 *     responses:
 *       200:
 *         description: Profile generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 description:
 *                   type: string
 *                 system:
 *                   type: string
 *                 bio:
 *                   type: array
 *                   items:
 *                     type: string
 *                 personality:
 *                   type: string
 *                 tradingStrategy:
 *                   type: string
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Rate limit exceeded
 *
 * @example
 * ```typescript
 * const profile = await fetch('/api/agents/generate-profile', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     archetype: { id: 'trader', name: 'Trader', description: '...' }
 *   })
 * }).then(r => r.json());
 * ```
 */

import { callGroqDirect } from "@polyagent/agents";
import {
  authenticateUser,
  checkRateLimitAndDuplicates,
  RATE_LIMIT_CONFIGS,
} from "@polyagent/api";
import { logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const user = await authenticateUser(req);

  // Apply rate limiting - 5 generations per minute
  const rateLimitError = checkRateLimitAndDuplicates(
    user.userId,
    null, // No duplicate detection for agent generation
    RATE_LIMIT_CONFIGS.GENERATE_AGENT_PROFILE,
  );

  if (rateLimitError) {
    logger.warn(
      "Agent profile generation rate limit exceeded",
      { userId: user.userId },
      "GenerateProfile",
    );
    return rateLimitError;
  }

  const body = await req.json();
  const { archetype, userProfile, existingProfile } = body;

  logger.info(
    "Generating agent profile",
    {
      hasArchetype: !!archetype,
      hasExistingProfile: !!existingProfile,
    },
    "GenerateProfile",
  );

  let prompt: string;

  if (existingProfile) {
    // Regenerating based on existing profile
    prompt = `You are an expert at creating AI agent personas for a prediction markets and trading platform.

Regenerate a fresh, creative agent profile while keeping the same general theme and style as this existing profile:

**Current Profile:**
- Name: ${existingProfile.name}
- Description: ${existingProfile.description || "Not set"}
- System Prompt: ${existingProfile.system}
- Personality: ${existingProfile.personality || "Not set"}
- Trading Strategy: ${existingProfile.tradingStrategy || "Not set"}

${userProfile?.name ? `The user creating this agent is: ${userProfile.name} (@${userProfile.username || "user"})${userProfile.bio ? `\nUser bio: ${userProfile.bio}` : ""}` : ""}

Generate a JSON response with the following fields:`;
  } else if (archetype) {
    // Initial generation with archetype
    prompt = `You are an expert at creating AI agent personas for a prediction markets and trading platform.

Create a complete agent profile based on this archetype:
**${archetype.name}** ${archetype.emoji}
${archetype.description}

${userProfile?.name ? `The user creating this agent is: ${userProfile.name} (@${userProfile.username || "user"})${userProfile.bio ? `\nUser bio: ${userProfile.bio}` : ""}` : ""}

Generate a JSON response with the following fields:`;
  } else {
    // No archetype or existing profile
    prompt = `You are an expert at creating AI agent personas for a prediction markets and trading platform.

Create a unique agent profile for an AI trading agent.

${userProfile?.name ? `The user creating this agent is: ${userProfile.name} (@${userProfile.username || "user"})${userProfile.bio ? `\nUser bio: ${userProfile.bio}` : ""}` : ""}

Generate a JSON response with the following fields:`;
  }

  prompt += `
{
  "name": "Creative agent name (2-4 words, no emojis)",
  "description": "One sentence description (max 150 chars)",
  "system": "Detailed system prompt that defines the agent's identity, behavior, and approach (2-3 paragraphs). Include specific instructions about how they analyze markets, make decisions, and interact with users.",
  "bio": ["3-5 short bio points that highlight key traits, strengths, or approaches"],
  "personality": "Personality description (2-3 sentences describing communication style and temperament)",
  "tradingStrategy": "Detailed trading strategy (2-3 paragraphs explaining their approach to markets, risk management, and decision-making process)"
}

Make it specific to the archetype. For example:
- "Degen" should be risk-taking, YOLO-focused, meme-savvy
- "Goody Two Shoes" should be ethical, conservative, rule-following  
- "Scammer" should be manipulative, deceptive, always looking for an angle
- "Super Predictor" should be data-driven, analytical, methodical
- "InfoSec" should be security-focused, paranoid about risks, cautious

The agent should have a distinct personality that shines through in every field.

Respond ONLY with valid JSON, no markdown formatting.`;

  const response = await callGroqDirect({
    prompt,
    modelSize: "large",
    temperature: 0.9,
    maxTokens: 2000,
    actionType: "generate_agent_profile",
  });

  // Parse the AI response
  // Extract JSON from markdown code blocks if present
  const jsonMatch =
    response.match(/```json\s*([\s\S]*?)\s*```/) ||
    response.match(/```\s*([\s\S]*?)\s*```/);
  const cleanedResponse = jsonMatch ? jsonMatch[1] : response;
  if (!cleanedResponse) {
    logger.error(
      "Failed to extract JSON from response",
      { response },
      "GenerateProfile",
    );
    return NextResponse.json(
      {
        success: false,
        error: "Failed to generate valid profile",
      },
      { status: 500 },
    );
  }
  const generated = JSON.parse(cleanedResponse.trim());

  // Validate the generated profile
  if (
    !generated.name ||
    !generated.system ||
    !generated.bio ||
    !Array.isArray(generated.bio)
  ) {
    logger.error(
      "Invalid generated profile structure",
      { generated },
      "GenerateProfile",
    );
    return NextResponse.json(
      {
        success: false,
        error: "Generated profile missing required fields",
      },
      { status: 500 },
    );
  }

  logger.info(
    `Successfully generated profile for ${archetype.name}`,
    undefined,
    "GenerateProfile",
  );

  return NextResponse.json({
    success: true,
    ...generated,
  });
}
