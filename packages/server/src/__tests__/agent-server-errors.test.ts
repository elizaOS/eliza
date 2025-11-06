/**
 * Error handling tests for AgentServer
 */

import { describe, it, expect } from 'bun:test';

// Mock logger to avoid console output during tests
// Import the real module first to preserve all exports
const coreModule = await import('@elizaos/core');

