import { describe, expect, it } from 'bun:test';
import { DefaultTickMetrics } from '../core/metrics';

describe('DefaultTickMetrics', () => {
  it('sets and gets values', () => {
    const m = new DefaultTickMetrics();
    m.set('posts', 5);
    m.set('active', true);
    expect(m.get('posts')).toBe(5);
    expect(m.get('active')).toBe(true);
  });

  it('increments numeric values', () => {
    const m = new DefaultTickMetrics();
    m.increment('count');
    m.increment('count');
    m.increment('count', 3);
    expect(m.get('count')).toBe(5);
  });

  it('increment on non-existent key initializes to amount', () => {
    const m = new DefaultTickMetrics();
    m.increment('x', 10);
    expect(m.get('x')).toBe(10);
  });

  it('does not increment non-numeric values', () => {
    const m = new DefaultTickMetrics();
    m.set('label', 'hello');
    m.increment('label', 1);
    expect(m.get('label')).toBe('hello');
  });

  it('collects warnings', () => {
    const m = new DefaultTickMetrics();
    m.addWarning('w1');
    m.addWarning('w2');
    expect(m.warnings()).toEqual(['w1', 'w2']);
  });

  it('snapshot returns plain object', () => {
    const m = new DefaultTickMetrics();
    m.set('a', 1);
    m.set('b', 'two');
    const snap = m.snapshot();
    expect(snap).toEqual({ a: 1, b: 'two' });
  });
});
