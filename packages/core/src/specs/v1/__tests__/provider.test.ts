import { describe, expect, it, mock } from 'bun:test';
import { ProviderResult } from '../../v2';
import { fromV2Provider, Provider, toV2Provider } from '../provider';
import { fromV2State } from '../state';

// Mock runtime and memory for testing
const mockRuntime = {
  getSetting: mock().mockReturnValue('test-setting'),
  logger: { info: mock(), error: mock() },
} as any;

const mockMessage = {
  id: '00000000-0000-0000-0000-000000000001',
  roomId: '00000000-0000-0000-0000-000000000002',
  content: { text: 'Test message' },
} as any;

describe('Provider adapter', () => {
  it('should convert from v2 provider to v1 provider correctly', async () => {
    // Arrange
    const mockResult: ProviderResult = {
      text: 'Provider result text',
      values: { key1: 'value1', key2: 'value2' },
      data: { dataKey: 'dataValue' },
    };

    const providerV2 = {
      name: 'testProvider',
      description: 'Test provider description',
      get: mock().mockResolvedValue(mockResult),
    };

    // Act
    const providerV1 = fromV2Provider(providerV2);
    const result = await providerV1.get(mockRuntime, mockMessage);

    // Assert
    expect(result).toEqual('Provider result text');
    expect(providerV2.get).toHaveBeenCalledWith(mockRuntime, mockMessage, undefined);
    expect(providerV1.name).toBe('testProvider');
    expect(providerV1.description).toBe('Test provider description');
  });

  it('should convert from v1 provider to v2 provider correctly', async () => {
    // Arrange
    const mockResult = {
      text: 'Provider result text',
      key1: 'value1',
      key2: 'value2',
    };

    const providerV1: Provider = {
      name: 'v1Provider',
      description: 'V1 provider test',
      get: mock().mockResolvedValue(mockResult),
    };

    // Act
    const providerV2 = toV2Provider(providerV1);
    const result = await providerV2.get(mockRuntime, mockMessage, {
      text: '',
      values: {},
      data: {},
    });

    // Assert
    expect(result).toEqual({
      ...mockResult,
      values: {},
      data: {},
      text: 'Provider result text',
    });
    expect(providerV1.get).toHaveBeenCalledWith(mockRuntime, mockMessage, {
      text: '',
      values: {},
      data: {},
    });
    expect(providerV2.name).toBe('v1Provider');
    expect(providerV2.description).toBe('V1 provider test');
  });

  it('should handle unnamed v1 providers properly', async () => {
    // Arrange
    const unnamedProvider: Provider = {
      get: mock().mockResolvedValue({ text: 'result' }),
    };

    // Act
    const providerV2 = toV2Provider(unnamedProvider);

    // Assert
    expect(providerV2.name).toBe('unnamed-provider');
    expect(providerV2.description).toBeUndefined();
  });

  it('should handle state conversion when passing to v2 provider', async () => {
    // Arrange
    // Create a v2 state first, then convert to v1 to ensure compatibility
    const v2State = {
      values: {
        userId: '00000000-0000-0000-0000-000000000003',
        walletBalance: 100,
      },
      data: {},
      text: '',
    };
    const mockState = fromV2State(v2State);

    const mockV2Provider = {
      name: 'stateTestProvider',
      get: mock().mockResolvedValue({ text: 'result' }),
    };

    // Act
    const v1Provider = fromV2Provider(mockV2Provider);
    await v1Provider.get(mockRuntime, mockMessage, mockState);

    // Assert
    // Check that the v2 provider was called with the converted state
    expect(mockV2Provider.get).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        values: {},
        data: {},
        text: '',
        userId: '00000000-0000-0000-0000-000000000003',
        walletBalance: 100,
      })
    );
  });

  it('should handle real-world provider example (TON wallet provider)', async () => {
    // Example based on TON wallet provider from plugin-ton
    const mockTonWalletProviderV1: Provider = {
      name: 'tonWalletProvider',
      get: mock().mockResolvedValue({
        text: 'You have 10.5 TON in your wallet.',
        walletAddress: '0x123abc',
        walletBalance: 10.5,
        tokenPrices: { TON: 5.25 },
      }),
    };

    // Convert to v2
    const tonWalletProviderV2 = toV2Provider(mockTonWalletProviderV1);

    // Use the v2 provider
    const result = await tonWalletProviderV2.get(mockRuntime, mockMessage, {
      text: 'Check my wallet',
      values: {},
      data: {},
    });

    // Assert the result is formatted as a proper ProviderResult
    expect(result).toEqual({
      walletAddress: '0x123abc',
      walletBalance: 10.5,
      tokenPrices: { TON: 5.25 },
      text: 'You have 10.5 TON in your wallet.',
      values: {},
      data: {},
    } as any);

    // Convert back to v1 and verify it still works
    const tonWalletProviderV1Again = fromV2Provider(tonWalletProviderV2);
    const resultV1 = await tonWalletProviderV1Again.get(mockRuntime, mockMessage);

    expect(resultV1).toEqual('You have 10.5 TON in your wallet.');
  });

  it('should handle primitive results from V1 providers', async () => {
    // Arrange
    const stringProvider: Provider = {
      name: 'stringProvider',
      get: mock().mockResolvedValue('Just a string result'),
    };

    const numberProvider: Provider = {
      name: 'numberProvider',
      get: mock().mockResolvedValue(42),
    };

    // Act
    const stringProviderV2 = toV2Provider(stringProvider);
    const numberProviderV2 = toV2Provider(numberProvider);

    const stringResult = await stringProviderV2.get(mockRuntime, mockMessage, {
      values: {},
      data: {},
      text: '',
    });
    const numberResult = await numberProviderV2.get(mockRuntime, mockMessage, {
      values: {},
      data: {},
      text: '',
    });

    // Assert
    expect(stringResult).toEqual({
      values: {},
      data: {},
      text: 'Just a string result',
    });

    expect(numberResult).toEqual({
      values: {},
      data: {},
      text: '42',
    });
  });

  it('should handle null or undefined results', async () => {
    // Arrange
    const nullProvider: Provider = {
      name: 'nullProvider',
      get: mock().mockResolvedValue(null),
    };

    const undefinedProvider: Provider = {
      name: 'undefinedProvider',
      get: mock().mockResolvedValue(undefined),
    };

    // Act
    const nullProviderV2 = toV2Provider(nullProvider);
    const undefinedProviderV2 = toV2Provider(undefinedProvider);

    const nullResult = await nullProviderV2.get(mockRuntime, mockMessage, {
      values: {},
      data: {},
      text: '',
    });
    const undefinedResult = await undefinedProviderV2.get(mockRuntime, mockMessage, {
      values: {},
      data: {},
      text: '',
    });

    // Assert
    expect(nullResult).toEqual({
      values: {},
      data: {},
      text: '',
    });

    expect(undefinedResult).toEqual({
      values: {},
      data: {},
      text: '',
    });
  });
});
