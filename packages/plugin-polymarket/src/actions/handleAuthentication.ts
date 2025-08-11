import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
// import { ClobClient } from '@polymarket/clob-client'; // Not needed if initializeClobClient returns typed client
import { initializeClobClient } from '../utils/clobClient';
import type { ClobClient } from '@polymarket/clob-client'; // For type assertion

// Interface for the parameters accepted by the action
interface HandleAuthenticationParams {
  privateKeyInput?: string;
  label?: string;
  expirationInDays?: number;
}

// Interface for the structure of derived API key credentials we will store/return
interface DerivedApiKeyCreds {
  key: string;
  secret: string;
  passphrase: string;
  label?: string;
  expiration_timestamp_ms?: number;
  key_id?: string;
}

// Interface for the actual raw response from ClobClient.deriveApiKey()
// based on examples: { apiKey, apiSecret, passphrase, label?, expiration_timestamp_ms? }
// Adjusted to match the actual observed response from deriveApiKey() which uses "key" and "secret"
interface RawDerivedApiKeyResponse {
  key: string; // Changed from apiKey
  secret: string; // Changed from apiSecret
  passphrase: string;
  label?: string;
  expiration_timestamp_ms?: number;
}

export const handleAuthenticationAction: Action = {
  name: 'POLYMARKET_HANDLE_AUTHENTICATION',
  similes: [
    'DERIVE_POLYMARKET_API_KEY',
    'CREATE_CLOB_API_KEY',
    'SETUP_POLYMARKET_AUTH',
    'GET_API_ACCESS_KEYS',
  ],
  description:
    'Derives a new Polymarket CLOB API key using a provided private key and sets it in runtime for use by other actions.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[handleAuthenticationAction] Validate called.`);
    logger.info(
      '[handleAuthenticationAction] Basic validation passed (private key check in handler).'
    );
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[handleAuthenticationAction] Handler called.');

    const params = (message.content?.data as HandleAuthenticationParams) || {};

    const privateKeyFromInput = params.privateKeyInput;
    const privateKeyFromSettings =
      runtime.getSetting('WALLET_PRIVATE_KEY') ||
      runtime.getSetting('PRIVATE_KEY') ||
      runtime.getSetting('POLYMARKET_PRIVATE_KEY');

    const privateKeyToUse = privateKeyFromInput || privateKeyFromSettings;

    if (!privateKeyToUse) {
      const errMsg =
        'A private key is required to derive API keys. Provide privateKeyInput parameter or set WALLET_PRIVATE_KEY/POLYMARKET_PRIVATE_KEY in agent settings.';
      logger.error(`[handleAuthenticationAction] ${errMsg}`);
      if (callback) await callback({ text: `❌ Error: ${errMsg}` });
      throw new Error(errMsg);
    }

    try {
      const runtimeForClientInit: Pick<IAgentRuntime, 'getSetting'> = {
        getSetting: (key: string): string | undefined => {
          if (
            (key === 'WALLET_PRIVATE_KEY' ||
              key === 'PRIVATE_KEY' ||
              key === 'POLYMARKET_PRIVATE_KEY') &&
            privateKeyFromInput
          ) {
            return privateKeyFromInput;
          }
          return runtime.getSetting(key);
        },
      };
      const clientSignerInstance = (await initializeClobClient(
        runtimeForClientInit as IAgentRuntime
      )) as ClobClient;

      logger.info(`[handleAuthenticationAction] Deriving API key...`);

      const derivedApiCredsFromClient =
        (await clientSignerInstance.deriveApiKey()) as unknown as RawDerivedApiKeyResponse;

      // Add robust check for the response structure, using "key" and "secret"
      if (
        !derivedApiCredsFromClient ||
        typeof derivedApiCredsFromClient.key !== 'string' ||
        typeof derivedApiCredsFromClient.secret !== 'string' ||
        typeof derivedApiCredsFromClient.passphrase !== 'string'
      ) {
        logger.error(
          '[handleAuthenticationAction] Invalid or incomplete response from deriveApiKey. Response: ',
          JSON.stringify(derivedApiCredsFromClient)
        );
        const errMsg =
          'Failed to derive valid API credentials from Polymarket. The response was unexpected.';
        if (callback) await callback({ text: `❌ Error: ${errMsg}` });
        throw new Error(errMsg);
      }

      const storedCreds: DerivedApiKeyCreds = {
        key: derivedApiCredsFromClient.key, // Use .key
        secret: derivedApiCredsFromClient.secret, // Use .secret
        passphrase: derivedApiCredsFromClient.passphrase,
        // If label/expiration are not part of the response, they won't be in storedCreds
        // We can add a default label here if desired for internal tracking, but it won't be from Polymarket
        label:
          derivedApiCredsFromClient.label ||
          'derived-key-' +
            (derivedApiCredsFromClient.key
              ? derivedApiCredsFromClient.key.substring(0, 8)
              : 'unknown'),
        expiration_timestamp_ms: derivedApiCredsFromClient.expiration_timestamp_ms,
        key_id: derivedApiCredsFromClient.key, // Use .key for key_id as well, assuming it's the API key ID
      };

      logger.info(
        `[handleAuthenticationAction] Successfully derived API Key ID: ${storedCreds.key_id}`
      );

      await runtime.setSetting('CLOB_API_KEY', storedCreds.key);
      await runtime.setSetting('CLOB_API_SECRET', storedCreds.secret);
      await runtime.setSetting('CLOB_API_PASSPHRASE', storedCreds.passphrase);

      logger.info(
        '[handleAuthenticationAction] Derived API credentials have been stored in runtime settings.'
      );

      let responseText = `🔑 **API Key Derived Successfully**\nAPI Key (ID): ${storedCreds.key_id}`;
      // Check key before substring for the default label comparison
      const defaultLabel =
        'derived-key-' +
        (derivedApiCredsFromClient.key ? derivedApiCredsFromClient.key.substring(0, 8) : 'unknown');
      if (storedCreds.label && storedCreds.label !== defaultLabel) {
        // Only show label if it was part of response and not the default
        responseText += `\nLabel: ${storedCreds.label}`;
      }
      if (storedCreds.expiration_timestamp_ms) {
        responseText += `\nExpiration: ${new Date(storedCreds.expiration_timestamp_ms).toLocaleString()}`;
      }
      responseText += `\n\nThese credentials have been set for immediate use by the Polymarket plugin.`;

      const responseContent: Content = {
        text: responseText,
        data: { derivedCreds: storedCreds, timestamp: new Date().toISOString() },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[handleAuthenticationAction] Error deriving API key:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error deriving API key**: ${errorMessage}`,
        data: { error: errorMessage, timestamp: new Date().toISOString() },
      };
      if (callback) await callback(errorContent);
      throw error;
    }
  },

  examples: [
    [
      { name: '{{user1}}', content: { text: 'Derive a new Polymarket API key for me.' } },
      {
        name: '{{user2}}',
        content: {
          text: "Okay, I will derive a new Polymarket API key. This requires your wallet's private key to be configured in settings.",
          action: 'POLYMARKET_HANDLE_AUTHENTICATION',
        },
      },
    ],
  ],
};
