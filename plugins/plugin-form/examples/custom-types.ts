/**
 * Example: Custom Field Types
 *
 * Demonstrates how to register custom field types for domain-specific validation:
 * - Blockchain addresses (Solana, EVM)
 * - Phone numbers
 * - URLs
 * - Custom business identifiers
 *
 * Usage:
 * 1. Call registerTypeHandlers(runtime) in your plugin init
 * 2. Use the custom types in your form definitions
 */

import type { IAgentRuntime } from '@elizaos/core';
import {
  Form,
  C,
  FormService,
  registerTypeHandler,
  type TypeHandler,
} from '../src/index';

// ============================================================================
// CUSTOM TYPE HANDLERS
// ============================================================================

/**
 * Solana wallet address validator.
 *
 * Validates Base58-encoded addresses (32-44 characters).
 */
export const solanaAddressHandler: TypeHandler = {
  validate: (value) => {
    const str = String(value).trim();
    // Base58 character set (no 0, O, I, l)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const valid = base58Regex.test(str);
    return {
      valid,
      error: valid ? undefined : 'Invalid Solana address. Must be 32-44 Base58 characters.',
    };
  },
  parse: (value) => value.trim(),
  format: (value) => {
    const str = String(value);
    if (str.length > 12) {
      return `${str.slice(0, 6)}...${str.slice(-4)}`;
    }
    return str;
  },
  extractionPrompt: 'a Solana wallet address (Base58 encoded, 32-44 characters, like "DRpbCBMxVnDK7maPH5a5nT8tA6oRfYJMa3rE5r9p7ggW")',
};

/**
 * EVM (Ethereum/Polygon/etc) address validator.
 *
 * Validates 0x-prefixed hex addresses.
 */
export const evmAddressHandler: TypeHandler = {
  validate: (value) => {
    const str = String(value).trim().toLowerCase();
    const valid = /^0x[a-f0-9]{40}$/.test(str);
    return {
      valid,
      error: valid ? undefined : 'Invalid EVM address. Must be 0x followed by 40 hex characters.',
    };
  },
  parse: (value) => value.trim().toLowerCase(),
  format: (value) => {
    const str = String(value);
    return `${str.slice(0, 6)}...${str.slice(-4)}`;
  },
  extractionPrompt: 'an Ethereum/EVM wallet address (0x followed by 40 hex characters, like "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD35")',
};

/**
 * US phone number validator.
 *
 * Accepts various formats: (555) 123-4567, 555-123-4567, 5551234567, etc.
 */
export const usPhoneHandler: TypeHandler = {
  validate: (value) => {
    // Remove all non-digits
    const digits = String(value).replace(/\D/g, '');
    // US numbers have 10 digits (or 11 with country code)
    const valid = digits.length === 10 || (digits.length === 11 && digits[0] === '1');
    return {
      valid,
      error: valid ? undefined : 'Invalid US phone number. Must be 10 digits.',
    };
  },
  parse: (value) => {
    // Normalize to just digits
    const digits = String(value).replace(/\D/g, '');
    // Remove leading 1 if present
    return digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  },
  format: (value) => {
    const digits = String(value).replace(/\D/g, '');
    const clean = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
    if (clean.length === 10) {
      return `(${clean.slice(0, 3)}) ${clean.slice(3, 6)}-${clean.slice(6)}`;
    }
    return value as string;
  },
  extractionPrompt: 'a US phone number (10 digits, any format like "(555) 123-4567" or "555-123-4567")',
};

/**
 * URL validator.
 *
 * Validates HTTP/HTTPS URLs.
 */
export const urlHandler: TypeHandler = {
  validate: (value) => {
    try {
      const url = new URL(String(value));
      const valid = url.protocol === 'http:' || url.protocol === 'https:';
      return {
        valid,
        error: valid ? undefined : 'Invalid URL. Must start with http:// or https://',
      };
    } catch {
      return {
        valid: false,
        error: 'Invalid URL format.',
      };
    }
  },
  parse: (value) => {
    let str = String(value).trim();
    // Add https:// if no protocol
    if (!str.match(/^https?:\/\//i)) {
      str = 'https://' + str;
    }
    return str;
  },
  format: (value) => {
    const str = String(value);
    // Remove protocol for display
    return str.replace(/^https?:\/\//, '');
  },
  extractionPrompt: 'a website URL (like "https://example.com" or "example.com")',
};

/**
 * Twitter/X handle validator.
 *
 * Validates @username format.
 */
export const twitterHandleHandler: TypeHandler = {
  validate: (value) => {
    const str = String(value).trim();
    // Remove @ if present
    const handle = str.startsWith('@') ? str.slice(1) : str;
    // Twitter handles: 1-15 chars, letters, numbers, underscores
    const valid = /^[A-Za-z0-9_]{1,15}$/.test(handle);
    return {
      valid,
      error: valid ? undefined : 'Invalid Twitter handle. Must be 1-15 characters (letters, numbers, underscore).',
    };
  },
  parse: (value) => {
    const str = String(value).trim();
    // Normalize to include @
    return str.startsWith('@') ? str : '@' + str;
  },
  format: (value) => String(value),
  extractionPrompt: 'a Twitter/X handle (like "@username" or "username")',
};

/**
 * Discord username validator.
 *
 * Validates new format (username) or legacy format (user#1234).
 */
export const discordUsernameHandler: TypeHandler = {
  validate: (value) => {
    const str = String(value).trim();
    // New format: 2-32 lowercase chars, numbers, underscores, periods
    const newFormat = /^[a-z0-9_.]{2,32}$/.test(str);
    // Legacy format: name#discriminator
    const legacyFormat = /^.{2,32}#\d{4}$/.test(str);
    const valid = newFormat || legacyFormat;
    return {
      valid,
      error: valid ? undefined : 'Invalid Discord username.',
    };
  },
  parse: (value) => String(value).trim().toLowerCase(),
  format: (value) => String(value),
  extractionPrompt: 'a Discord username (like "username" or legacy "name#1234")',
};

// ============================================================================
// REGISTRATION FUNCTION
// ============================================================================

/**
 * Register all custom type handlers.
 *
 * Call this in your plugin's init function.
 */
export function registerCustomTypes(): void {
  registerTypeHandler('solana_address', solanaAddressHandler);
  registerTypeHandler('evm_address', evmAddressHandler);
  registerTypeHandler('us_phone', usPhoneHandler);
  registerTypeHandler('url', urlHandler);
  registerTypeHandler('twitter', twitterHandleHandler);
  registerTypeHandler('discord', discordUsernameHandler);
}

// ============================================================================
// EXAMPLE FORM USING CUSTOM TYPES
// ============================================================================

/**
 * Web3 profile form using custom types.
 */
export const web3ProfileForm = Form.create('web3-profile')
  .name('Web3 Profile')
  .description('Set up your Web3 profile')

  // Solana address (custom type)
  .control(
    C.field('solanaWallet')
      .type('solana_address')
      .required()
      .label('Solana Wallet')
      .ask("What's your Solana wallet address?")
      .example('DRpbCBMxVnDK7maPH5a5nT8tA6oRfYJMa3rE5r9p7ggW')
  )

  // EVM address (custom type)
  .control(
    C.field('evmWallet')
      .type('evm_address')
      .label('EVM Wallet')
      .ask('Do you have an Ethereum or Polygon wallet address? (Optional)')
      .example('0x742d35Cc6634C0532925a3b844Bc9e7595f2bD35')
  )

  // Twitter (custom type)
  .control(
    C.field('twitter')
      .type('twitter')
      .label('Twitter/X')
      .ask("What's your Twitter handle? (Optional)")
      .example('@username')
  )

  // Discord (custom type)
  .control(
    C.field('discord')
      .type('discord')
      .label('Discord')
      .ask("What's your Discord username? (Optional)")
      .example('username')
  )

  // Website (custom type)
  .control(
    C.field('website')
      .type('url')
      .label('Website')
      .ask('Do you have a personal website? (Optional)')
      .example('https://example.com')
  )

  .onSubmit('save_web3_profile')
  .build();

// ============================================================================
// CONTACT FORM WITH PHONE
// ============================================================================

export const contactForm = Form.create('contact-with-phone')
  .name('Contact Information')
  .description('Provide your contact details')

  .control(C.text('name').required().ask("What's your name?"))

  .control(C.email('email').required().ask("What's your email?"))

  .control(
    C.field('phone')
      .type('us_phone')
      .label('Phone Number')
      .ask("What's your phone number?")
      .example('(555) 123-4567')
  )

  .onSubmit('save_contact')
  .build();

// ============================================================================
// PLUGIN EXAMPLE
// ============================================================================

export const customTypesPlugin = {
  name: 'example-custom-types',
  description: 'Example showing custom field types',
  dependencies: ['form'],

  init: async (runtime: IAgentRuntime) => {
    // Register custom types FIRST
    registerCustomTypes();

    // Then register forms that use them
    const formService = runtime.getService('FORM') as FormService;
    if (formService) {
      formService.registerForm(web3ProfileForm);
      formService.registerForm(contactForm);
    }

    runtime.logger.info('[CustomTypesPlugin] Registered custom types and forms');
  },
};

export default customTypesPlugin;

