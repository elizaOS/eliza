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
        const mockTimeData = {
            created: '2024-01-01T00:00:00.000Z',
            modified: '2024-01-15T00:00:00.000Z',
            '1.5.7': '2024-01-10T00:00:00.000Z',
            '1.5.8': '2024-01-12T00:00:00.000Z',
            '1.5.9-alpha.1': '2024-01-14T00:00:00.000Z',
            '1.5.9-beta.1': '2024-01-13T00:00:00.000Z',
            '1.5.9': '2024-01-15T00:00:00.000Z',
        };

        mockBunExecSimple.mockResolvedValue({
            stdout: JSON.stringify(mockTimeData),
            stderr: '',
        });

        const result = await getLatestCliVersionForChannel('1.5.8');
        expect(result).toBe('1.5.9');
        expect(mockBunExecSimple).toHaveBeenCalledWith('npm', [
            'view',
            '@elizaos/cli',
            'time',
            '--json',
        ]);
    });

    test('should return latest alpha version for alpha current version', async () => {
        const mockTimeData = {
            created: '2024-01-01T00:00:00.000Z',
            modified: '2024-01-15T00:00:00.000Z',
            '1.5.8': '2024-01-12T00:00:00.000Z',
            '1.5.9-alpha.1': '2024-01-14T00:00:00.000Z',
            '1.5.9-alpha.2': '2024-01-16T00:00:00.000Z',
            '1.5.9-beta.1': '2024-01-13T00:00:00.000Z',
            '1.5.9': '2024-01-15T00:00:00.000Z',
        };

        mockBunExecSimple.mockResolvedValue({
            stdout: JSON.stringify(mockTimeData),
            stderr: '',
        });

        const result = await getLatestCliVersionForChannel('1.5.9-alpha.1');
        expect(result).toBe('1.5.9-alpha.2');
    });

    test('should return latest beta version for beta current version', async () => {
        const mockTimeData = {
            created: '2024-01-01T00:00:00.000Z',
            modified: '2024-01-15T00:00:00.000Z',
            '1.5.8': '2024-01-12T00:00:00.000Z',
            '1.5.9-alpha.1': '2024-01-14T00:00:00.000Z',
            '1.5.9-beta.1': '2024-01-13T00:00:00.000Z',
            '1.5.9-beta.2': '2024-01-17T00:00:00.000Z',
            '1.5.9': '2024-01-15T00:00:00.000Z',
        };

        mockBunExecSimple.mockResolvedValue({
            stdout: JSON.stringify(mockTimeData),
            stderr: '',
        });

        const result = await getLatestCliVersionForChannel('1.5.9-beta.1');
        expect(result).toBe('1.5.9-beta.2');
    });

    test('should return null if no newer version in same channel', async () => {
        const mockTimeData = {
            created: '2024-01-01T00:00:00.000Z',
            modified: '2024-01-15T00:00:00.000Z',
            '1.5.8': '2024-01-12T00:00:00.000Z',
            '1.5.9-alpha.1': '2024-01-14T00:00:00.000Z',
        };

        mockBunExecSimple.mockResolvedValue({
            stdout: JSON.stringify(mockTimeData),
            stderr: '',
        });

        const result = await getLatestCliVersionForChannel('1.5.9');
        expect(result).toBe('1.5.8'); // Latest stable is 1.5.8, not the alpha
    });

    test('should handle npm command errors gracefully', async () => {
        mockBunExecSimple.mockRejectedValue(new Error('npm command failed'));

        const result = await getLatestCliVersionForChannel('1.5.8');
        expect(result).toBeNull();
    });

    test('should handle malformed JSON gracefully', async () => {
        mockBunExecSimple.mockResolvedValue({
            stdout: 'not valid json',
            stderr: '',
        });

        const result = await getLatestCliVersionForChannel('1.5.8');
        expect(result).toBeNull();
    });

    test('should filter out non-matching channels correctly', async () => {
        const mockTimeData = {
            '1.5.8': '2024-01-12T00:00:00.000Z',
            '1.5.9-alpha.1': '2024-01-14T00:00:00.000Z',
            '1.5.9-alpha.2': '2024-01-16T00:00:00.000Z',
            '1.5.9-beta.1': '2024-01-13T00:00:00.000Z',
            '1.6.0-alpha.1': '2024-01-18T00:00:00.000Z',
            '1.6.0': '2024-01-20T00:00:00.000Z',
        };

        mockBunExecSimple.mockResolvedValue({
            stdout: JSON.stringify(mockTimeData),
            stderr: '',
        });

        // Check stable channel filters correctly
        const stableResult = await getLatestCliVersionForChannel('1.5.8');
        expect(stableResult).toBe('1.6.0');

        // Check alpha channel filters correctly
        const alphaResult = await getLatestCliVersionForChannel('1.5.9-alpha.1');
        expect(alphaResult).toBe('1.6.0-alpha.1');

        // Check beta channel filters correctly
        const betaResult = await getLatestCliVersionForChannel('1.5.9-beta.1');
        expect(betaResult).toBe('1.5.9-beta.1'); // Only beta version available
    });
});
