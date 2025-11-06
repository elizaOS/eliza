/**
 * API endpoint basic tests
 */

import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import express from 'express';
import http from 'node:http';
import { AgentServer } from '../index';

// Mock only plugin-sql to avoid real database operations
