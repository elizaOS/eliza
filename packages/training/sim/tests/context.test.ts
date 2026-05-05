import { describe, expect, it } from 'bun:test';
import type { DrizzleClient } from '@babylon/db';
import type { Logger } from '@babylon/shared';
import { createTickContext, DefaultTickSharedData } from '../core/context';
import { DefaultServiceContainer } from '../core/service-container';
import type { EngineContext } from '../core/types';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function makeEngineCtx(budgetMs = 60000): EngineContext {
  return {
    db: {} as DrizzleClient,
    llm: { execute: async () => ({}) as never, getClient: () => ({}) },
    logger: mockLogger,
    services: new DefaultServiceContainer(),
    config: { budgetMs },
    hooks: { hook: () => () => {}, hookOnce: () => () => {} },
  };
}

describe('DefaultTickSharedData', () => {
  it('get returns undefined for missing keys', () => {
    const shared = new DefaultTickSharedData();
    expect(shared.get('nope')).toBeUndefined();
  });

  it('set and get work with typed values', () => {
    const shared = new DefaultTickSharedData();
    shared.set('count', 42);
    shared.set('label', 'hello');
    shared.set('nested', { a: [1, 2] });

    expect(shared.get<number>('count')).toBe(42);
    expect(shared.get<string>('label')).toBe('hello');
    expect(shared.get<{ a: number[] }>('nested')).toEqual({ a: [1, 2] });
  });

  it('has returns correct results', () => {
    const shared = new DefaultTickSharedData();
    shared.set('exists', true);

    expect(shared.has('exists')).toBe(true);
    expect(shared.has('missing')).toBe(false);
  });

  it('overwrites existing keys', () => {
    const shared = new DefaultTickSharedData();
    shared.set('x', 1);
    shared.set('x', 2);
    expect(shared.get<number>('x')).toBe(2);
  });
});

describe('createTickContext', () => {
  it('creates a tick context with correct fields', () => {
    const engineCtx = makeEngineCtx();
    const ctx = createTickContext(engineCtx, 5, 10);

    expect(ctx.tickNumber).toBe(5);
    expect(ctx.dayNumber).toBe(10);
    expect(ctx.timestamp).toBeInstanceOf(Date);
    expect(typeof ctx.deadline).toBe('number');
    expect(ctx.deadline).toBeGreaterThan(Date.now() - 1000);
    expect(ctx.metrics).toBeDefined();
    expect(ctx.shared).toBeDefined();
  });

  it('inherits engine context properties', () => {
    const engineCtx = makeEngineCtx();
    const ctx = createTickContext(engineCtx, 1);

    expect(ctx.db).toBe(engineCtx.db);
    expect(ctx.llm).toBe(engineCtx.llm);
    expect(ctx.logger).toBe(engineCtx.logger);
    expect(ctx.services).toBe(engineCtx.services);
    expect(ctx.config).toBe(engineCtx.config);
    expect(ctx.hooks).toBe(engineCtx.hooks);
  });

  it('dayNumber defaults to undefined', () => {
    const ctx = createTickContext(makeEngineCtx(), 1);
    expect(ctx.dayNumber).toBeUndefined();
  });

  it('isPastDeadline returns false within budget', () => {
    const ctx = createTickContext(makeEngineCtx(60000), 1);
    expect(ctx.isPastDeadline()).toBe(false);
  });

  it('isPastDeadline returns true when budget is negative', () => {
    const ctx = createTickContext(makeEngineCtx(-1), 1);
    expect(ctx.isPastDeadline()).toBe(true);
  });

  it('creates fresh metrics and shared data per call', () => {
    const engineCtx = makeEngineCtx();
    const ctx1 = createTickContext(engineCtx, 1);
    const ctx2 = createTickContext(engineCtx, 2);

    ctx1.metrics.set('a', 1);
    ctx1.shared.set('b', 2);

    expect(ctx2.metrics.get('a')).toBeUndefined();
    expect(ctx2.shared.get('b')).toBeUndefined();
  });
});
