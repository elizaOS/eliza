/**
 * Agent Template by Archetype API
 *
 * @route GET /api/agent-templates/[archetype]
 * @access Public
 *
 * @description
 * Returns a specific agent template by archetype ID. Uses TypeScript imports
 * for optimal performance and type safety.
 *
 * @returns {Promise<NextResponse>} JSON response with template data
 */

import { getTemplate } from "@polyagent/agents";
import { NextResponse } from "next/server";

/**
 * GET /api/agent-templates/[archetype]
 *
 * @description Fetches a specific agent template by archetype
 *
 * @returns {Promise<NextResponse>} Template data
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ archetype: string }> },
) {
  const { archetype } = await params;
  const template = getTemplate(archetype);

  if (!template) {
    return NextResponse.json(
      { error: `Template '${archetype}' not found` },
      { status: 404 },
    );
  }

  return NextResponse.json(template);
}
