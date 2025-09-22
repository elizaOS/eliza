import type { ActionResult } from '../types/components';

/**
 * Helper function to create ActionResult with proper defaults
 */
export function createActionResult(partial: Partial<ActionResult> = {}): ActionResult {
  return {
    success: true, // Default to success
    ...partial,
  };
}
