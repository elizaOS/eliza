import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock bunExecSimple
const mockBunExecSimple = mock(() => Promise.resolve({ stdout: '', stderr: '' }));

mock.module('../bun-exec', () => ({
  bunExecSimple: mockBunExecSimple,
}));

import { getVersionChannel, getLatestCliVersionForChannel } from '../version-channel';

describe('getVersionChannel', () => {
  test('should detect stable/latest versions', () => {
    expect(getVersionChannel('1.5.8')).toBe('latest');
    expect(getVersionChannel('2.0.0')).toBe('latest');
    expect(getVersionChannel('1.0.0')).toBe('latest');
    expect(getVersionChannel('10.2.3')).toBe('latest');
  });

  test('should detect alpha versions', () => {
    expect(getVersionChannel('1.5.9-alpha.1')).toBe('alpha');
    expect(getVersionChannel('2.0.0-alpha.0')).toBe('alpha');
    expect(getVersionChannel('1.0.0-alpha.beta')).toBe('alpha'); // alpha takes precedence
    expect(getVersionChannel('1.0.0-alpha')).toBe('alpha');
  });

  test('should detect beta versions', () => {
    expect(getVersionChannel('1.5.9-beta.1')).toBe('beta');
    expect(getVersionChannel('2.0.0-beta.0')).toBe('beta');
    expect(getVersionChannel('1.0.0-beta')).toBe('beta');
  });

  test('should handle complex version strings', () => {
    expect(getVersionChannel('1.5.9-alpha.1+build.123')).toBe('alpha');
    expect(getVersionChannel('2.0.0-beta.2+sha.abc123')).toBe('beta');
    expect(getVersionChannel('1.0.0+build.456')).toBe('latest'); // build metadata only means stable
  });

  test('should handle edge cases', () => {
    expect(getVersionChannel('')).toBe('latest');
    expect(getVersionChannel('not-a-version')).toBe('latest');
    expect(getVersionChannel('v1.0.0')).toBe('latest');
    expect(getVersionChannel('v1.0.0-alpha')).toBe('alpha');
  });
});

describe('getLatestCliVersionForChannel', () => {
  beforeEach(() => {
    mockBunExecSimple.mockClear();
  });

  test('should return latest stable version for stable current version', async () => {
    mockBunExecSimple.mockResolvedValue({
      stdout: '1.5.9\n',
      stderr: '',
    });

    const result = await getLatestCliVersionForChannel('1.5.8');
    expect(result).toBe('1.5.9');
    expect(mockBunExecSimple).toHaveBeenCalledWith('npm', [
      'view',
      '@elizaos/cli@latest',
      'version',
    ]);
  });

  test('should return latest alpha version for alpha current version', async () => {
    mockBunExecSimple.mockResolvedValue({
      stdout: '1.5.9-alpha.2\n',
      stderr: '',
    });

    const result = await getLatestCliVersionForChannel('1.5.9-alpha.1');
    expect(result).toBe('1.5.9-alpha.2');
    expect(mockBunExecSimple).toHaveBeenCalledWith('npm', [
      'view',
      '@elizaos/cli@alpha',
      'version',
    ]);
  });

  test('should return latest beta version for beta current version', async () => {
    mockBunExecSimple.mockResolvedValue({
      stdout: '1.5.9-beta.2\n',
      stderr: '',
    });

    const result = await getLatestCliVersionForChannel('1.5.9-beta.1');
    expect(result).toBe('1.5.9-beta.2');
    expect(mockBunExecSimple).toHaveBeenCalledWith('npm', ['view', '@elizaos/cli@beta', 'version']);
  });

  test('should return null when already at latest version', async () => {
    mockBunExecSimple.mockResolvedValue({
      stdout: '1.5.8\n',
      stderr: '',
    });

    const result = await getLatestCliVersionForChannel('1.5.8');
    expect(result).toBeNull(); // Same version, no update needed
    expect(mockBunExecSimple).toHaveBeenCalledWith('npm', [
      'view',
      '@elizaos/cli@latest',
      'version',
    ]);
  });

  test('should handle npm command errors gracefully', async () => {
    mockBunExecSimple.mockRejectedValue(new Error('npm command failed'));

    const result = await getLatestCliVersionForChannel('1.5.8');
    expect(result).toBeNull();
  });

  test('should handle empty response gracefully', async () => {
    mockBunExecSimple.mockResolvedValue({
      stdout: '',
      stderr: '',
    });

    const result = await getLatestCliVersionForChannel('1.5.8');
    expect(result).toBeNull();
  });

  test('should verify correct dist-tags are used for each channel', async () => {
    // Test stable channel
    mockBunExecSimple.mockResolvedValue({ stdout: '1.6.0\n', stderr: '' });
    await getLatestCliVersionForChannel('1.5.8');
    expect(mockBunExecSimple).toHaveBeenLastCalledWith('npm', [
      'view',
      '@elizaos/cli@latest',
      'version',
    ]);

    // Test alpha channel
    mockBunExecSimple.mockResolvedValue({ stdout: '1.6.0-alpha.1\n', stderr: '' });
    await getLatestCliVersionForChannel('1.5.9-alpha.1');
    expect(mockBunExecSimple).toHaveBeenLastCalledWith('npm', [
      'view',
      '@elizaos/cli@alpha',
      'version',
    ]);

    // Test beta channel
    mockBunExecSimple.mockResolvedValue({ stdout: '1.5.9-beta.1\n', stderr: '' });
    await getLatestCliVersionForChannel('1.5.9-beta.1');
    expect(mockBunExecSimple).toHaveBeenLastCalledWith('npm', [
      'view',
      '@elizaos/cli@beta',
      'version',
    ]);
  });
});
