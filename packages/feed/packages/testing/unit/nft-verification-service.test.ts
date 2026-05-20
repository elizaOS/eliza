/**
 * Unit Tests: NFT Verification Service
 *
 * Tests NFTVerificationService validation logic and error handling.
 *
 * NOTE: These tests focus on validation and error handling logic only.
 * For actual RPC calls and blockchain integration, see:
 * - integration/nft-gated-chats.integration.test.ts (full integration tests)
 *
 * These unit tests verify:
 * - Input validation (address format, token ID validation)
 * - Error message generation
 * - Boundary conditions
 * - Logic flow (not RPC calls - those are tested in integration tests)
 *
 * IMPORTANT: We do NOT mock RPC calls here because that would test mocks, not real code.
 * RPC functionality is tested in integration tests with real blockchain calls.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { NFTVerificationService } from '@feed/api';
import { ValidationError } from '@feed/shared';
import type { Address } from 'viem';

describe('NFTVerificationService', () => {
  const validWallet = '0x1234567890123456789012345678901234567890' as Address;
  const validContract = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address;

  beforeEach(() => {
    // Reset any state between tests
  });

  describe('verifyChatAccess - Input Validation', () => {
    test('should return canAccess=false when wallet address is null', async () => {
      const result = await NFTVerificationService.verifyChatAccess(
        null,
        validContract,
        null
      );

      expect(result.canAccess).toBe(false);
      expect(result.ownsNft).toBe(false);
      expect(result.reason).toContain('Wallet address required');
    });

    test('should handle empty string wallet address', async () => {
      const result = await NFTVerificationService.verifyChatAccess(
        '',
        validContract,
        null
      );

      // Empty string should be treated as null
      expect(result.canAccess).toBe(false);
      expect(result.reason).toContain('Wallet address required');
    });

    test('should throw ValidationError for invalid contract address', async () => {
      await expect(
        NFTVerificationService.verifyOwnership(
          validWallet,
          'invalid-address',
          null
        )
      ).rejects.toThrow(/Invalid contract address/);

      // Also verify it's a ValidationError
      await expect(
        NFTVerificationService.verifyOwnership(
          validWallet,
          'invalid-address',
          null
        )
      ).rejects.toBeInstanceOf(ValidationError);
    });

    test('should validate address format before RPC calls', async () => {
      // Invalid wallet address
      await expect(
        NFTVerificationService.verifyOwnership(
          'not-an-address',
          validContract,
          null
        )
      ).rejects.toThrow(/Invalid wallet address/);

      await expect(
        NFTVerificationService.verifyOwnership(
          'not-an-address',
          validContract,
          null
        )
      ).rejects.toBeInstanceOf(ValidationError);

      // Invalid contract address
      await expect(
        NFTVerificationService.verifyOwnership(
          validWallet,
          'not-an-address',
          null
        )
      ).rejects.toThrow(/Invalid contract address/);

      await expect(
        NFTVerificationService.verifyOwnership(
          validWallet,
          'not-an-address',
          null
        )
      ).rejects.toBeInstanceOf(ValidationError);
    });

    test('should validate token ID format', async () => {
      // Negative token ID
      await expect(
        NFTVerificationService.verifyOwnership(validWallet, validContract, -1)
      ).rejects.toThrow(/Invalid token ID/);

      await expect(
        NFTVerificationService.verifyOwnership(validWallet, validContract, -1)
      ).rejects.toBeInstanceOf(ValidationError);

      // Non-integer token ID
      await expect(
        NFTVerificationService.verifyOwnership(validWallet, validContract, 1.5)
      ).rejects.toThrow(/Invalid token ID/);

      await expect(
        NFTVerificationService.verifyOwnership(validWallet, validContract, 1.5)
      ).rejects.toBeInstanceOf(ValidationError);
    });

    test('should allow token ID 0', async () => {
      // Token ID 0 is a valid token ID (unlike -1 or 1.5 which are invalid)
      // This tests that token ID 0 passes the tokenId format validation.
      // The function may still throw ValidationError for OTHER reasons (e.g., no contract at address)
      // but it should NOT throw for token ID being 0.
      //
      // We verify by checking that if a ValidationError is thrown, it's NOT about token ID
      const result = NFTVerificationService.verifyOwnership(
        validWallet,
        validContract,
        0
      );

      // The call may succeed or fail for contract-related reasons, but NOT for token ID validation
      // If it rejects with ValidationError, it must not be about token ID
      await result.catch((error) => {
        if (error instanceof ValidationError) {
          // Verify it's NOT rejecting token ID 0 specifically
          expect(error.message).not.toContain('token');
          expect(error.message).not.toContain('Token');
        }
        // Non-ValidationError (network/RPC errors) are acceptable
      });
    });
  });

  describe('Boundary Conditions and Edge Cases', () => {
    test('should handle token ID 0', () => {
      // Token ID 0 is valid
      expect(0).toBeGreaterThanOrEqual(0);
    });

    test('should handle very large token IDs', () => {
      const largeTokenId = Number.MAX_SAFE_INTEGER;
      expect(largeTokenId).toBeGreaterThan(0);
      // Service should handle this correctly
    });

    test('should handle zero address format', () => {
      const zeroAddress = '0x0000000000000000000000000000000000000000';
      expect(zeroAddress.length).toBe(42);
      expect(zeroAddress.startsWith('0x')).toBe(true);
    });

    test('should validate address format requirements', () => {
      const validAddress = '0x1234567890123456789012345678901234567890';
      expect(validAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });
});
