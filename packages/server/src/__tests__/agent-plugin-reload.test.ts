/**
 * Agent plugin reload tests
 * Tests plugin change detection and agent restart logic for PATCH /api/agents/:agentId endpoint
 * Addresses issues:
 * - Plugin change detection using proper array comparison
 * - Agent restart with error recovery
 * - Input validation for plugins array
 */

import { describe, it, expect, beforeEach, jest } from 'bun:test';
import type { Character } from '@elizaos/core';

// Type for plugins (string or object with name)
type PluginType = string | { name: string };

// Mock logger to avoid console output during tests
