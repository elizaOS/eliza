/**
 * Agent Templates API
 *
 * @route GET /api/agent-templates
 * @access Public
 *
 * @description
 * Returns all available agent templates. Uses TypeScript imports for optimal
 * performance and type safety.
 *
 * @returns {Promise<NextResponse>} JSON response with templates data
 */

import { getAllTemplates, getTemplateIds } from '@babylon/agents';
import { withErrorHandling } from '@babylon/api';
import { NextResponse } from 'next/server';

/**
 * GET /api/agent-templates
 *
 * @description Fetches all available agent templates
 *
 * @returns {Promise<NextResponse>} Templates data
 */
export const GET = withErrorHandling(async function GET() {
  const templates = getAllTemplates();
  const templateIds = getTemplateIds();

  return NextResponse.json({
    templates: Array.from(templateIds),
    templatesData: templates,
  });
});
