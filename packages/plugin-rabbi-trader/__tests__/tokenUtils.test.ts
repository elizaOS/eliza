import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadTokenAddresses } from '../src/tokenUtils';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs and path
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return {
        ...actual,
        readFileSync: vi.fn()
    };
});

vi.mock('path', async () => {
    const actual = await vi.importActual('path');
    return {
        ...actual,
        resolve: vi.fn()
    };
});

describe('Token Utils', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Setup default mock implementation
        vi.mocked(path.resolve).mockReturnValue('/mock/path/tokenaddresses.json');
    });

    describe('loadTokenAddresses', () => {
        it('should load and parse token addresses successfully', () => {
            const mockAddresses = ['0x123', '0x456', '0x789'];
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockAddresses));

            const addresses = loadTokenAddresses();
            expect(addresses).toEqual(mockAddresses);
            expect(fs.readFileSync).toHaveBeenCalledWith('/mock/path/tokenaddresses.json', 'utf8');
        });

        it('should throw error if file is not found', () => {
            vi.mocked(fs.readFileSync).mockImplementation(() => {
                throw new Error('ENOENT: no such file or directory');
            });

            expect(() => loadTokenAddresses()).toThrow('Token addresses file not found or invalid');
        });

        it('should throw error if file contains invalid JSON', () => {
            vi.mocked(fs.readFileSync).mockReturnValue('invalid json content');

            expect(() => loadTokenAddresses()).toThrow('Token addresses file not found or invalid');
        });

        it('should use correct file path', () => {
            const mockAddresses = ['0x123'];
            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockAddresses));

            loadTokenAddresses();
            expect(path.resolve).toHaveBeenCalledWith(
                process.cwd(),
                '../characters/tokens/tokenaddresses.json'
            );
        });
    });
});
