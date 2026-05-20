import { describe, expect, it } from 'bun:test';
import {
  CircularDependencyError,
  FrameworkError,
  ServiceNotFoundError,
  SystemNotFoundError,
} from '../core/errors';

describe('FrameworkError', () => {
  it('is an instance of Error', () => {
    const err = new FrameworkError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FrameworkError);
  });

  it('has correct name and message', () => {
    const err = new FrameworkError('something broke');
    expect(err.name).toBe('FrameworkError');
    expect(err.message).toBe('something broke');
  });
});

describe('SystemNotFoundError', () => {
  it('extends FrameworkError', () => {
    const err = new SystemNotFoundError('missing-mod', 'requester');
    expect(err).toBeInstanceOf(FrameworkError);
    expect(err).toBeInstanceOf(Error);
  });

  it('includes module id and requester in message', () => {
    const err = new SystemNotFoundError('dep-x', 'mod-y');
    expect(err.name).toBe('SystemNotFoundError');
    expect(err.message).toContain('dep-x');
    expect(err.message).toContain('mod-y');
  });
});

describe('CircularDependencyError', () => {
  it('extends FrameworkError', () => {
    const err = new CircularDependencyError(['a', 'b', 'a']);
    expect(err).toBeInstanceOf(FrameworkError);
  });

  it('includes cycle in message', () => {
    const err = new CircularDependencyError(['a', 'b', 'c']);
    expect(err.name).toBe('CircularDependencyError');
    expect(err.message).toContain('a -> b -> c');
  });
});

describe('ServiceNotFoundError', () => {
  it('extends FrameworkError', () => {
    const err = new ServiceNotFoundError('cache', ['db', 'llm']);
    expect(err).toBeInstanceOf(FrameworkError);
  });

  it('includes token and available services in message', () => {
    const err = new ServiceNotFoundError('cache', ['db', 'llm']);
    expect(err.name).toBe('ServiceNotFoundError');
    expect(err.message).toContain('cache');
    expect(err.message).toContain('db, llm');
  });

  it('handles empty available list', () => {
    const err = new ServiceNotFoundError('anything', []);
    expect(err.message).toContain('anything');
    expect(err.message).toContain('[]');
  });
});
