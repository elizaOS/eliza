import { describe, expect, it } from 'bun:test';
import { ServiceNotFoundError } from '../core/errors';
import { DefaultServiceContainer } from '../core/service-container';

describe('DefaultServiceContainer', () => {
  it('registers and retrieves a service', () => {
    const container = new DefaultServiceContainer();
    container.register('db', { host: 'localhost' });
    expect(container.get<{ host: string }>('db').host).toBe('localhost');
  });

  it('throws on duplicate registration', () => {
    const container = new DefaultServiceContainer();
    container.register('db', {});
    expect(() => container.register('db', {})).toThrow('already registered');
  });

  it('throws ServiceNotFoundError on missing token', () => {
    const container = new DefaultServiceContainer();
    container.register('a', 1);
    expect(() => container.get('missing')).toThrow(ServiceNotFoundError);
  });

  it('has() returns correct results', () => {
    const container = new DefaultServiceContainer();
    container.register('x', 42);
    expect(container.has('x')).toBe(true);
    expect(container.has('y')).toBe(false);
  });

  it('tokens() lists all registered tokens', () => {
    const container = new DefaultServiceContainer();
    container.register('a', 1);
    container.register('b', 2);
    expect(container.tokens()).toEqual(['a', 'b']);
  });
});
