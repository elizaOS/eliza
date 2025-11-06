/**
 * Database operations tests for AgentServer
 */

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { AgentServer } from '../index';
import type { UUID, ChannelType } from '@elizaos/core';

// Mock logger to avoid console output during tests
