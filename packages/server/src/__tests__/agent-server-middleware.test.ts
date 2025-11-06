/**
 * Server lifecycle and middleware tests for AgentServer
 */

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { AgentServer } from '../index';
import http from 'node:http';

// Mock logger to avoid console output during tests
