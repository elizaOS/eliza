/**
 * Test setup for Vercel AI Gateway plugin.
 */

import { vi } from "vitest";

// Mock fetch globally
global.fetch = vi.fn();

