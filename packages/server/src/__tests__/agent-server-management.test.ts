/**
 * Agent management tests for AgentServer
 */

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { AgentServer } from '../index';

// Mock logger to avoid console output during tests
