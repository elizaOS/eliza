import { describe, expect, it, vi, beforeEach } from 'vitest';
import submitData, { isDataContent } from '../../src/actions/submitData';
import { generateObjectDeprecated } from '@elizaos/core';
import { composeContext } from '@elizaos/core';
import * as availJsSdk from 'avail-js-sdk';

vi.mock('@elizaos/core', () => ({
    generateObjectDeprecated: vi.fn(),
    composeContext: vi.fn(),
}));

vi.mock('avail-js-sdk', () => ({
    initialize: vi.fn(),
    getKeyringFromSeed: vi.fn(),
}));

describe('submitData', () => {
    let mockRuntime;
    let mockMessage;
    let mockState;
    let mockCallback;

    beforeEach(() => {
        mockRuntime = {
            getSetting: vi.fn((key: string) => {
                switch (key) {
                    case 'AVAIL_SEED':
                        return 'mock-seed';
                    case 'AVAIL_RPC_URL':
                        return 'mock-node-url';
                    case 'AVAIL_APP_ID':
                        return '0';
                    case 'AVAIL_ADDRESS':
                        return '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
                    default:
                        return undefined;
                }
            }),
            composeState: vi.fn().mockResolvedValue({}),
            updateRecentMessageState: vi.fn().mockResolvedValue({}),
        };

        mockMessage = {
            content: {
                data: 'test data'
            }
        };
        mockState = {};
        mockCallback = vi.fn();

        vi.mocked(generateObjectDeprecated).mockReset();
        vi.mocked(composeContext).mockReset();
    });

    it('should validate correctly', async () => {
        const result = await submitData.validate(mockRuntime, mockMessage);
        expect(result).toBe(true);
    });

    it('should have correct action properties', () => {
        expect(submitData.name).toBe('SUBMIT_DATA');
        expect(submitData.description).toBe('Submit data to Avail as per user command');
        expect(submitData.examples).toBeDefined();
        expect(Array.isArray(submitData.examples)).toBe(true);
    });

    it('should validate data content correctly', () => {
        const invalidContent = { invalidField: 'test' };
        expect(isDataContent(invalidContent)).toBe(false);

        const invalidDataType = { data: 123 };
        expect(isDataContent(invalidDataType)).toBe(false);
    });
});
