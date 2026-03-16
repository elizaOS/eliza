import { describe, it, expect, vi } from 'vitest';
import teeStarterPlugin from '../src/plugin';
import { logger } from '@elizaos/core';

// Spy on logger to capture logs
vi.spyOn(logger, 'info');
vi.spyOn(logger, 'error');
vi.spyOn(logger, 'warn');

// Mock the character import to avoid file system dependencies
vi.mock('../src/character', () => ({
  mrTeeCharacter: {
    name: 'Mr. TEE',
    plugins: ['@elizaos/plugin-tee'],
  },
}));

describe('TEE Starter Plugin', () => {
  it('should have the correct name', () => {
    expect(teeStarterPlugin.name).toBe('mr-tee-starter-plugin');
  });

  it('should have the correct description', () => {
    expect(teeStarterPlugin.description).toBe(
      "Mr. TEE's starter plugin - using plugin-tee for attestation"
    );
  });

  it('should have no custom actions (using plugin-tee instead)', () => {
    expect(teeStarterPlugin.actions).toEqual([]);
  });

  it('should have no custom providers', () => {
    expect(teeStarterPlugin.providers).toEqual([]);
  });

  it('should have no custom evaluators', () => {
    expect(teeStarterPlugin.evaluators).toBeUndefined();
  });

  it('should have no custom services', () => {
    expect(teeStarterPlugin.services).toEqual([]);
  });
});
