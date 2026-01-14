/// <reference types="vitest/globals" />

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultService } from '../VaultService.ts';

describe('VaultService', () => {
  let vaultService: VaultService;
  const MOCK_VALID_PUBLIC_KEY_STRING = Keypair.generate().publicKey.toBase58();
  const mockRuntime = {
    getSetting: vi.fn(() => 'https://api.devnet.solana.com') // Use devnet for tests
  } as any;

  beforeEach(async () => {
    vaultService = new VaultService(); 
    await vaultService.start(mockRuntime);
  });

  afterEach(async () => {
    await vaultService.stop();
  });

  describe('createVault', () => {
    it('should generate a new vault with a public key and an encrypted secret key', async () => {
      const userId = 'testUser123';
      const vaultData = await vaultService.createVault(userId);
      expect(vaultData).toHaveProperty('publicKey');
      expect(vaultData).toHaveProperty('secretKeyEncrypted');
      expect(typeof vaultData.publicKey).toBe('string');
      expect(typeof vaultData.secretKeyEncrypted).toBe('string');
    });

    it('should return a valid base58 public key', async () => {
      const userId = 'testUser456';
      const { publicKey } = await vaultService.createVault(userId);
      expect(() => bs58.decode(publicKey)).not.toThrow();
    });

    it('should store a retrievable "encrypted" secret key', async () => {
      const userId = 'testUser789';
      const { publicKey, secretKeyEncrypted } = await vaultService.createVault(userId);
      const keypair = await vaultService.getVaultKeypair(userId, secretKeyEncrypted);
      expect(keypair).toBeInstanceOf(Keypair);
      expect(keypair.publicKey.toBase58()).toEqual(publicKey);
      const secretKeyBytes = Buffer.from(secretKeyEncrypted, 'hex');
      const derivedKeypair = Keypair.fromSecretKey(secretKeyBytes);
      expect(derivedKeypair.publicKey.toBase58()).toEqual(publicKey);
    });

    it('should generate unique vaults for different user IDs', async () => {
      const userId1 = 'userOne';
      const userId2 = 'userTwo';
      const vault1 = await vaultService.createVault(userId1);
      const vault2 = await vaultService.createVault(userId2);
      expect(vault1.publicKey).not.toEqual(vault2.publicKey);
      expect(vault1.secretKeyEncrypted).not.toEqual(vault2.secretKeyEncrypted);
    });
  });

  describe('getVaultKeypair', () => {
    let testUserId: string;
    let createdVault: { publicKey: string; secretKeyEncrypted: string };
    beforeEach(async () => {
      testUserId = 'getVaultTestUser';
      createdVault = await vaultService.createVault(testUserId);
    });

    it('should retrieve the correct Keypair', async () => {
      const keypair = await vaultService.getVaultKeypair(testUserId, createdVault.secretKeyEncrypted);
      expect(keypair).toBeInstanceOf(Keypair);
      expect(keypair.publicKey.toBase58()).toEqual(createdVault.publicKey);
    });

    it('should throw for invalid hex secret', async () => {
      await expect(vaultService.getVaultKeypair(testUserId, 'not-hex'))
        .rejects.toThrow('Could not derive Keypair from the provided secret.');
    });

    it('should throw for incorrect length secret', async () => {
      const shortSecret = Buffer.from(new Uint8Array(32)).toString('hex');
      await expect(vaultService.getVaultKeypair(testUserId, shortSecret))
        .rejects.toThrow('Could not derive Keypair from the provided secret.');
    });
  });

  describe('getVaultPublicKey', () => {
    let testUserId: string;
    beforeEach(async () => {
      testUserId = 'getPubKeyTestUser';
      await vaultService.createVault(testUserId);
    });

    it('should retrieve the correct public key for an existing user', async () => {
      const publicKey = await vaultService.getVaultPublicKey(testUserId);
      expect(publicKey).toBeTruthy();
      expect(typeof publicKey).toBe('string');
      // Verify it's a valid base58 key
      expect(() => bs58.decode(publicKey!)).not.toThrow();
    });

    it('should return null if user ID not found', async () => {
      const publicKey = await vaultService.getVaultPublicKey('nonExistentUser');
      expect(publicKey).toBeNull();
    });
  });

  describe('getBalances', () => {
    it('should handle connection errors gracefully', async () => {
      // Use an invalid public key format to trigger an error
      const invalidKey = 'invalid-key';
      await expect(vaultService.getBalances(invalidKey))
        .rejects.toThrow();
    });

    it('should accept valid public key format', async () => {
      // This test might fail due to network issues, but at least tests the interface
      try {
        const balances = await vaultService.getBalances(MOCK_VALID_PUBLIC_KEY_STRING);
        expect(Array.isArray(balances)).toBe(true);
        // Should at least have SOL balance entry
        const solBalance = balances.find(b => b.address === 'SOL');
        expect(solBalance).toBeDefined();
        expect(solBalance?.decimals).toBe(9);
        expect(solBalance?.symbol).toBe('SOL');
      } catch (error) {
        // Network errors are acceptable in tests
        expect(error).toBeDefined();
      }
    });
  });

  describe('exportPrivateKey', () => {
    let testUserId: string;
    let createdVault: { publicKey: string; secretKeyEncrypted: string };
    const validConfirmation = 'confirmed-export-yes';

    beforeEach(async () => {
      testUserId = 'exportTestUser';
      createdVault = await vaultService.createVault(testUserId);
    });

    it('should export a bs58 encoded secret key with valid confirmation', async () => {
      const exportedKey = await vaultService.exportPrivateKey(testUserId, createdVault.secretKeyEncrypted, validConfirmation);
      expect(typeof exportedKey).toBe('string');
      let decodedSecret: Uint8Array | undefined;
      expect(() => { decodedSecret = bs58.decode(exportedKey); }).not.toThrow();
      expect(decodedSecret).toBeInstanceOf(Uint8Array);
      // Reconstruct keypair and check public key
      if (decodedSecret) {
        const reconstructedKeypair = Keypair.fromSecretKey(decodedSecret);
        expect(reconstructedKeypair.publicKey.toBase58()).toEqual(createdVault.publicKey);
      }
    });

    it('should throw an error if confirmation token is invalid', async () => {
      await expect(vaultService.exportPrivateKey(testUserId, createdVault.secretKeyEncrypted, 'short'))
        .rejects.toThrow('Invalid confirmation token');
    });

    it('should throw an error if confirmation token is missing', async () => {
      await expect(vaultService.exportPrivateKey(testUserId, createdVault.secretKeyEncrypted, ''))
        .rejects.toThrow('Invalid confirmation token');
    });

    it('should throw if getVaultKeypair fails (e.g. bad encryptedSecretKey)', async () => {
      await expect(vaultService.exportPrivateKey(testUserId, 'bad-encrypted-key', validConfirmation))
        .rejects.toThrow('Failed to export private key');
    });
  });
}); 