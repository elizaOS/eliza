import { initializeClobClientWithCreds } from '../../src/utils/clobClient';
import { IAgentRuntime, Memory, State, HandlerCallback, logger as coreLogger } from '@elizaos/core';

// Mock ClobClient and its methods
const mockDeleteApiKey = jest.fn();
const mockClobClient = {
  deleteApiKey: mockDeleteApiKey,
};

// Mock initializeClobClientWithCreds
jest.mock('../../src/utils/clobClient', () => ({
  initializeClobClientWithCreds: jest.fn(() => Promise.resolve(mockClobClient)),
}));

// Mock @elizaos/core logger
// jest.mock('@elizaos/core', () => ({
//   ...jest.requireActual('@elizaos/core'), // Import and retain default exports
//   logger: {
//     info: jest.fn(),
//     warn: jest.fn(),
//     error: jest.fn(),
//     debug: jest.fn(),
//   },
// }));
// Note: The above mock for logger might conflict if other parts of @elizaos/core are needed unmocked.
// It's often better to spyOn(coreLogger, 'method') or ensure the logger is injectable if deeper testing is needed.
// For now, we rely on the fact that the action imports the logger instance directly.
// To assert on logger calls, we can spy on the imported instance.
let spyLoggerInfo: any;
let spyLoggerWarn: any;
let spyLoggerError: any;

const mockGetSetting = jest.fn();
const mockRuntime = {
  getSetting: mockGetSetting,
  // Add other IAgentRuntime properties if needed by the action
} as unknown as IAgentRuntime;

const mockCallback: HandlerCallback = jest.fn();
const mockMessage = {} as Memory;
const mockState = {} as State;

describe('deleteApiKeyAction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default successful settings for most tests
    mockGetSetting.mockImplementation((key: string) => {
      if (key === 'CLOB_API_KEY') return 'configured-api-key-id';
      if (key === 'CLOB_API_SECRET') return 'test-secret';
      if (key === 'CLOB_API_PASSPHRASE') return 'test-passphrase';
      if (key === 'WALLET_PRIVATE_KEY') return 'test-private-key';
      return undefined;
    });
    // Spy on the actual logger methods from @elizaos/core that deleteApiKeyAction uses
    spyLoggerInfo = jest.spyOn(coreLogger, 'info').mockImplementation(() => {});
    spyLoggerWarn = jest.spyOn(coreLogger, 'warn').mockImplementation(() => {});
    spyLoggerError = jest.spyOn(coreLogger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    spyLoggerInfo.mockRestore();
    spyLoggerWarn.mockRestore();
    spyLoggerError.mockRestore();
  });

  describe('validate', () => {
    it('should return true if all required settings are present', async () => {
      const isValid = await deleteApiKeyAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(true);
    });

    it('should return false and log error if CLOB_API_KEY is missing', async () => {
      mockGetSetting.mockImplementation((key: string) =>
        key === 'CLOB_API_KEY' ? undefined : 'valid-value'
      );
      const isValid = await deleteApiKeyAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(false);
      expect(spyLoggerError).toHaveBeenCalledWith(
        '[deleteApiKeyAction] Missing required API credentials (CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE) in environment.'
      );
    });

    it('should return false and log error if WALLET_PRIVATE_KEY is missing', async () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'CLOB_API_KEY') return 'configured-api-key-id';
        if (key === 'CLOB_API_SECRET') return 'test-secret';
        if (key === 'CLOB_API_PASSPHRASE') return 'test-passphrase';
        // WALLET_PRIVATE_KEY is missing
        return undefined;
      });
      const isValid = await deleteApiKeyAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(false);
      expect(spyLoggerError).toHaveBeenCalledWith(
        '[deleteApiKeyAction] Missing WALLET_PRIVATE_KEY (or alias) in environment. This is required by the underlying client initialization.'
      );
    });

    it('should return true if CLOB_API_URL is provided', async () => {
      mockGetSetting.mockImplementation((key: string) => {
        if (key === 'CLOB_API_URL') return 'https://clob.polymarket.com';
        if (key === 'CLOB_API_KEY') return 'configured-api-key-id';
        if (key === 'CLOB_API_SECRET') return 'test-secret';
        if (key === 'CLOB_API_PASSPHRASE') return 'test-passphrase';
        if (key === 'WALLET_PRIVATE_KEY') return 'test-private-key';
        return undefined;
      });
      const isValid = await deleteApiKeyAction.validate(mockRuntime, mockMessage);
      expect(isValid).toBe(true);
    });
  });

  describe('handler', () => {
    const payload: DeleteApiKeyPayload = { apiKeyId: 'configured-api-key-id' };

    it('should call ClobClient.deleteApiKey and return success if key is deleted', async () => {
      mockDeleteApiKey.mockResolvedValueOnce(undefined); // Simulate successful deletion

      await deleteApiKeyAction.handler(mockRuntime, mockMessage, mockState, payload, mockCallback);

      expect(initializeClobClientWithCreds).toHaveBeenCalledWith(mockRuntime);
      expect(mockDeleteApiKey).toHaveBeenCalledTimes(1);
      expect(mockCallback).toHaveBeenCalledWith({
        text: '✅ Successfully deleted API Key: configured-api-key-id',
        data: {
          success: true,
          deletedKeyId: 'configured-api-key-id',
          message: 'API Key ID: configured-api-key-id was successfully deleted from Polymarket.',
        },
      });
      expect(spyLoggerInfo).toHaveBeenCalledWith(
        '[deleteApiKeyAction] API Key ID: configured-api-key-id was successfully deleted from Polymarket.'
      );
    });

    it('should log a warning if intendedApiKeyIdFromPayload does not match configuredApiKey, but still delete configured key', async () => {
      const mismatchedPayload: DeleteApiKeyPayload = { apiKeyId: 'mismatched-key-id' };
      mockDeleteApiKey.mockResolvedValueOnce(undefined);

      await deleteApiKeyAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        mismatchedPayload,
        mockCallback
      );

      expect(spyLoggerWarn).toHaveBeenCalledWith(
        '[deleteApiKeyAction] User intended to delete API key ID "mismatched-key-id", but the currently configured CLOB_API_KEY is "configured-api-key-id". The action will attempt to delete the configured key: "configured-api-key-id".'
      );
      expect(mockDeleteApiKey).toHaveBeenCalledTimes(1); // Still called for the configured key
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({ data: { success: true, deletedKeyId: 'configured-api-key-id' } })
      );
    });

    it('should handle ClobClient.deleteApiKey throwing a "not found" error', async () => {
      const notFoundError = new Error('API key not found');
      (notFoundError as any).status = 404; // Simulate a status code if applicable
      mockDeleteApiKey.mockRejectedValueOnce(notFoundError);

      await deleteApiKeyAction.handler(mockRuntime, mockMessage, mockState, payload, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: '❌ Failed to delete API Key configured-api-key-id: Configured API Key (ID: configured-api-key-id) not found or invalid. It may have already been deleted.',
        data: {
          success: false,
          deletedKeyId: 'configured-api-key-id',
          message:
            'Configured API Key (ID: configured-api-key-id) not found or invalid. It may have already been deleted.',
          error: 'API key not found',
        },
      });
    });

    it('should handle a generic error from ClobClient.deleteApiKey', async () => {
      const genericError = new Error('Some generic network issue');
      mockDeleteApiKey.mockRejectedValueOnce(genericError);

      await deleteApiKeyAction.handler(mockRuntime, mockMessage, mockState, payload, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: '❌ Failed to delete API Key configured-api-key-id: Some generic network issue',
        data: {
          success: false,
          deletedKeyId: 'configured-api-key-id',
          message: 'Some generic network issue',
          error: 'Some generic network issue',
        },
      });
    });

    it('should call callback with error if CLOB_API_KEY is not configured', async () => {
      mockGetSetting.mockImplementation((key: string) =>
        key === 'CLOB_API_KEY' ? undefined : 'valid-value'
      );

      await deleteApiKeyAction.handler(mockRuntime, mockMessage, mockState, payload, mockCallback);

      const errMsg =
        '[deleteApiKeyAction] CLOB_API_KEY is not configured in the environment. Cannot determine which key to delete.';
      expect(mockCallback).toHaveBeenCalledWith({
        text: `${errMsg} Please set CLOB_API_KEY, CLOB_API_SECRET, and CLOB_API_PASSPHRASE.`,
        data: { success: false, error: errMsg },
      });
      expect(mockDeleteApiKey).not.toHaveBeenCalled();
      expect(spyLoggerError).toHaveBeenCalledWith(errMsg);
    });

    it('should proceed if intendedApiKeyIdFromPayload is not provided, deleting configured key', async () => {
      const noIntendedIdPayload: DeleteApiKeyPayload = { apiKeyId: '' }; // Or undefined, if allowed by type, though schema says required
      mockDeleteApiKey.mockResolvedValueOnce(undefined);

      await deleteApiKeyAction.handler(
        mockRuntime,
        mockMessage,
        mockState,
        noIntendedIdPayload,
        mockCallback
      );
      expect(spyLoggerInfo).toHaveBeenCalledWith(
        '[deleteApiKeyAction] No specific apiKeyId provided in payload by user, will delete the configured CLOB_API_KEY: "configured-api-key-id"'
      );
      expect(mockDeleteApiKey).toHaveBeenCalledTimes(1);
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({ data: { success: true, deletedKeyId: 'configured-api-key-id' } })
      );
    });
  });
});
