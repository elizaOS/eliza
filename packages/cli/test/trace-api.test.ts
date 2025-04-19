import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createTraceRouter } from '../src/server/api/trace';
import express from 'express';
import { UUID } from '@elizaos/core';

// Mock data
const mockLogs = [
  {
    id: '123e4567-e89b-12d3-a456-426614174002',
    entityId: '123e4567-e89b-12d3-a456-426614174001',
    type: 'trace',
    timestamp: Date.now(),
    body: {
      duration: 100,
      attributes: { test: 'value' },
      events: [
        {
          name: 'event1',
          timestamp: Date.now(),
          attributes: { eventAttr: 'value' },
        },
      ],
      status: { code: 0, message: 'success' },
      parentSpanId: null,
    },
  },
  {
    id: '123e4567-e89b-12d3-a456-426614174003',
    entityId: '123e4567-e89b-12d3-a456-426614174001',
    type: 'trace',
    timestamp: Date.now() + 50,
    body: {
      duration: 50,
      attributes: { test: 'child' },
      events: [],
      status: { code: 0 },
      parentSpanId: '123e4567-e89b-12d3-a456-426614174002',
    },
  },
];

// Mock database adapter
const mockDb = {
  getLogs: async ({ entityId, type }: { entityId: UUID; type: string }) => {
    if (entityId === '123e4567-e89b-12d3-a456-426614174001' && type === 'trace') {
      return mockLogs;
    }
    if (entityId === '123e4567-e89b-12d3-a456-426614174999' && type === 'trace') {
      throw new Error('Database error');
    }
    return [];
  },
};

describe('Trace API', () => {
  let server: any;
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use('/api/traces', createTraceRouter(mockDb));
    server = app.listen(3001);
  });

  afterAll(() => {
    server?.close();
  });

  it('should return 400 for invalid traceId format', async () => {
    const response = await fetch('http://localhost:3001/api/traces/invalid-trace-id');
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid traceId format. Must be a valid UUID.');
  });

  it('should return 404 for non-existent trace', async () => {
    const traceId = '123e4567-e89b-12d3-a456-426614174000';
    const response = await fetch(`http://localhost:3001/api/traces/${traceId}`);
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe(`No trace data found for traceId: ${traceId}`);
  });

  it('should return trace data for valid traceId', async () => {
    const traceId = '123e4567-e89b-12d3-a456-426614174001';
    const response = await fetch(`http://localhost:3001/api/traces/${traceId}`);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('resourceSpans');
    expect(Array.isArray(data.resourceSpans)).toBe(true);
    expect(data.resourceSpans[0]).toHaveProperty('scopeSpans');
    expect(Array.isArray(data.resourceSpans[0].scopeSpans)).toBe(true);
    expect(data.resourceSpans[0].scopeSpans[0]).toHaveProperty('spans');
    expect(Array.isArray(data.resourceSpans[0].scopeSpans[0].spans)).toBe(true);
    expect(data.resourceSpans[0].scopeSpans[0].spans.length).toBe(2);

    // Verify parent span
    const parentSpan = data.resourceSpans[0].scopeSpans[0].spans[0];
    expect(parentSpan).toMatchObject({
      traceId: traceId,
      spanId: mockLogs[0].id,
      name: mockLogs[0].type,
      kind: 1, // INTERNAL
      startTimeUnixNano: mockLogs[0].timestamp * 1000000,
      endTimeUnixNano: (mockLogs[0].timestamp + mockLogs[0].body.duration) * 1000000,
      attributes: Object.entries(mockLogs[0].body.attributes).map(([key, value]) => ({
        key,
        value: { stringValue: String(value) },
      })),
      events: mockLogs[0].body.events.map((event) => ({
        timeUnixNano: event.timestamp * 1000000,
        name: event.name,
        attributes: Object.entries(event.attributes).map(([key, value]) => ({
          key,
          value: { stringValue: String(value) },
        })),
      })),
      status: {
        code: mockLogs[0].body.status.code,
        message: mockLogs[0].body.status.message,
      },
    });

    // Verify child span
    const childSpan = data.resourceSpans[0].scopeSpans[0].spans[1];
    expect(childSpan).toMatchObject({
      traceId: traceId,
      spanId: mockLogs[1].id,
      name: mockLogs[1].type,
      kind: 1, // INTERNAL
      startTimeUnixNano: mockLogs[1].timestamp * 1000000,
      endTimeUnixNano: (mockLogs[1].timestamp + mockLogs[1].body.duration) * 1000000,
      attributes: Object.entries(mockLogs[1].body.attributes).map(([key, value]) => ({
        key,
        value: { stringValue: String(value) },
      })),
      events: mockLogs[1].body.events,
      status: {
        code: mockLogs[1].body.status.code,
      },
    });

    // Verify parent-child relationship
    expect(childSpan.parentSpanId).toBe(parentSpan.spanId);
  });

  it('should return 500 for database errors', async () => {
    const response = await fetch(
      'http://localhost:3001/api/traces/123e4567-e89b-12d3-a456-426614174999'
    );
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe('Internal server error while retrieving trace data');
  });
});
