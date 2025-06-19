import { describe, it, expect, spyOn, mock } from 'bun:test';
import teeStarterPlugin from '../src/plugin';
import { logger } from '@elizaos/core';

// Spy on logger to capture logs
spyOn(logger, 'info');
spyOn(logger, 'error');
spyOn(logger, 'warn');

// Note: Character import handled by individual tests as needed

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
