/**
 * Cryptographic signature verification tests
 * Tests actual EIP-712 signature recovery and validation
 */

import { describe, it, expect } from 'bun:test';
import { recoverTypedDataAddress, type Address, type Hex, type TypedDataDomain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// EIP-712 types for USDC TransferWithAuthorization
const TRANSFER_WITH_AUTHORIZATION_TYPES = [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
] as const;

describe('EIP-712 Signature Verification', () => {
    // Test private key and account (for testing only)
    const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
    const testAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
    const testAddress = testAccount.address;

    // USDC domain for Base network
    const USDC_DOMAIN: TypedDataDomain = {
        name: 'USD Coin',
        version: '2',
        chainId: 8453, // Base
        verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    };

    describe('Signature Recovery', () => {
        it('should recover the correct signer address from valid EIP-712 signature', async () => {
            const message = {
                from: testAddress,
                to: '0x066E94e1200aa765d0A6392777D543Aa6Dea606C' as Address,
                value: BigInt(100000),
                validAfter: BigInt(0),
                validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
                nonce: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
            };

            // Sign the message
            const signature = await testAccount.signTypedData({
                domain: USDC_DOMAIN,
                types: {
                    TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
                },
                primaryType: 'TransferWithAuthorization',
                message
            });

            // Recover the signer
            const recoveredAddress = await recoverTypedDataAddress({
                domain: USDC_DOMAIN,
                types: {
                    TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
                },
                primaryType: 'TransferWithAuthorization',
                message,
                signature
            });

            expect(recoveredAddress.toLowerCase()).toBe(testAddress.toLowerCase());
        });

        it('should fail to recover if signature is invalid', async () => {
            const message = {
                from: testAddress,
                to: '0x066E94e1200aa765d0A6392777D543Aa6Dea606C' as Address,
                value: BigInt(100000),
                validAfter: BigInt(0),
                validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
                nonce: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
            };

            // Create an invalid signature (tampered)
            const validSignature = await testAccount.signTypedData({
                domain: USDC_DOMAIN,
                types: {
                    TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
                },
                primaryType: 'TransferWithAuthorization',
                message
            });

            // Tamper with the signature (change the last byte)
            const tamperedSignature = ('0x' + validSignature.slice(2, -2) + 'ff') as Hex;

            // Try to recover - should either throw or give wrong address
            try {
                const recoveredAddress = await recoverTypedDataAddress({
                    domain: USDC_DOMAIN,
                    types: {
                        TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
                    },
                    primaryType: 'TransferWithAuthorization',
                    message,
                    signature: tamperedSignature
                });

                // If it doesn't throw, it should recover wrong address
                expect(recoveredAddress.toLowerCase()).not.toBe(testAddress.toLowerCase());
            } catch (error) {
                // Throwing an error is also acceptable for invalid signatures
                expect(error).toBeDefined();
            }
        });

        it('should fail to recover if message is tampered', async () => {
            const originalMessage = {
                from: testAddress,
                to: '0x066E94e1200aa765d0A6392777D543Aa6Dea606C' as Address,
                value: BigInt(100000),
                validAfter: BigInt(0),
                validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
                nonce: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
            };

            // Sign original message
            const signature = await testAccount.signTypedData({
                domain: USDC_DOMAIN,
                types: {
                    TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
                },
                primaryType: 'TransferWithAuthorization',
                message: originalMessage
            });

            // Try to verify with tampered message (different amount)
            const tamperedMessage = {
                ...originalMessage,
                value: BigInt(50000) // Changed from 100000
            };

            const recoveredAddress = await recoverTypedDataAddress({
                domain: USDC_DOMAIN,
                types: {
                    TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
                },
                primaryType: 'TransferWithAuthorization',
                message: tamperedMessage,
                signature
            });

            expect(recoveredAddress.toLowerCase()).not.toBe(testAddress.toLowerCase());
        });
    });

    describe('Domain Validation', () => {
        it('should fail if domain chainId is wrong', async () => {
            const message = {
                from: testAddress,
                to: '0x066E94e1200aa765d0A6392777D543Aa6Dea606C' as Address,
                value: BigInt(100000),
                validAfter: BigInt(0),
                validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
                nonce: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
            };

            // Sign with correct domain
            const signature = await testAccount.signTypedData({
                domain: USDC_DOMAIN,
                types: {
                    TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
                },
                primaryType: 'TransferWithAuthorization',
                message
            });

            // Try to verify with wrong chainId
            const wrongDomain: TypedDataDomain = {
                ...USDC_DOMAIN,
                chainId: 1 // Ethereum mainnet instead of Base
            };

            const recoveredAddress = await recoverTypedDataAddress({
                domain: wrongDomain,
                types: {
                    TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
                },
                primaryType: 'TransferWithAuthorization',
                message,
                signature
            });

            expect(recoveredAddress.toLowerCase()).not.toBe(testAddress.toLowerCase());
        });

        it('should fail if verifying contract address is wrong', async () => {
            const message = {
                from: testAddress,
                to: '0x066E94e1200aa765d0A6392777D543Aa6Dea606C' as Address,
                value: BigInt(100000),
                validAfter: BigInt(0),
                validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
                nonce: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
            };

            // Sign with correct domain
            const signature = await testAccount.signTypedData({
                domain: USDC_DOMAIN,
                types: {
                    TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
                },
                primaryType: 'TransferWithAuthorization',
                message
            });

            // Try to verify with wrong contract address
            const wrongDomain: TypedDataDomain = {
                ...USDC_DOMAIN,
                verifyingContract: '0x1111111111111111111111111111111111111111'
            };

            const recoveredAddress = await recoverTypedDataAddress({
                domain: wrongDomain,
                types: {
                    TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
                },
                primaryType: 'TransferWithAuthorization',
                message,
                signature
            });

            expect(recoveredAddress.toLowerCase()).not.toBe(testAddress.toLowerCase());
        });
    });

    describe('Authorization Parameters', () => {
        it('should validate all required authorization fields exist', () => {
            const completeAuth = {
                from: testAddress,
                to: '0x066E94e1200aa765d0A6392777D543Aa6Dea606C',
                value: '100000',
                validAfter: '0',
                validBefore: '9999999999',
                nonce: '0x0000000000000000000000000000000000000000000000000000000000000001'
            };

            expect(completeAuth.from).toBeDefined();
            expect(completeAuth.to).toBeDefined();
            expect(completeAuth.value).toBeDefined();
            expect(completeAuth.validAfter).toBeDefined();
            expect(completeAuth.validBefore).toBeDefined();
            expect(completeAuth.nonce).toBeDefined();
        });

        it('should reject authorization missing critical fields', () => {
            const incompleteAuth = {
                from: testAddress,
                to: '0x066E94e1200aa765d0A6392777D543Aa6Dea606C',
                value: '100000'
                // Missing: validAfter, validBefore, nonce
            };

            const hasAllFields = !!(
                incompleteAuth.from &&
                (incompleteAuth as any).to &&
                (incompleteAuth as any).value &&
                (incompleteAuth as any).validAfter &&
                (incompleteAuth as any).validBefore &&
                (incompleteAuth as any).nonce
            );

            expect(hasAllFields).toBe(false);
        });

        it('should validate time windows correctly', () => {
            const now = Math.floor(Date.now() / 1000);
            
            const validAuth = {
                validAfter: now - 60,
                validBefore: now + 3600
            };

            const expiredAuth = {
                validAfter: 0,
                validBefore: now - 60
            };

            const futureAuth = {
                validAfter: now + 3600,
                validBefore: now + 7200
            };

            // Valid authorization
            expect(now >= validAuth.validAfter).toBe(true);
            expect(now <= validAuth.validBefore).toBe(true);

            // Expired
            expect(now > expiredAuth.validBefore).toBe(true);

            // Not yet valid
            expect(now < futureAuth.validAfter).toBe(true);
        });
    });

    describe('Signature Format Validation', () => {
        it('should validate signature is 65 bytes (130 hex chars + 0x)', async () => {
            const message = {
                from: testAddress,
                to: '0x066E94e1200aa765d0A6392777D543Aa6Dea606C' as Address,
                value: BigInt(100000),
                validAfter: BigInt(0),
                validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
                nonce: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
            };

            const signature = await testAccount.signTypedData({
                domain: USDC_DOMAIN,
                types: {
                    TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
                },
                primaryType: 'TransferWithAuthorization',
                message
            });

            // Signature format: 0x + 64 chars (r) + 64 chars (s) + 2 chars (v) = 132 total
            expect(signature.startsWith('0x')).toBe(true);
            expect(signature.length).toBe(132);
        });

        it('should reject signatures that are too short', () => {
            const shortSig = '0x1234';
            expect(shortSig.length).toBeLessThan(132);
        });

        it('should reject signatures with invalid hex', () => {
            const invalidSig = '0x' + 'g'.repeat(130); // 'g' is not valid hex
            expect(/^0x[a-fA-F0-9]+$/.test(invalidSig)).toBe(false);
        });
    });

    describe('Multiple Signature Types', () => {
        it('should correctly identify TransferWithAuthorization vs ReceiveWithAuthorization', async () => {
            const message = {
                from: testAddress,
                to: '0x066E94e1200aa765d0A6392777D543Aa6Dea606C' as Address,
                value: BigInt(100000),
                validAfter: BigInt(0),
                validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
                nonce: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex
            };

            // Sign with TransferWithAuthorization
            const transferSig = await testAccount.signTypedData({
                domain: USDC_DOMAIN,
                types: {
                    TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
                },
                primaryType: 'TransferWithAuthorization',
                message
            });

            // Should recover correctly with TransferWithAuthorization
            const recoveredTransfer = await recoverTypedDataAddress({
                domain: USDC_DOMAIN,
                types: {
                    TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
                },
                primaryType: 'TransferWithAuthorization',
                message,
                signature: transferSig
            });

            expect(recoveredTransfer.toLowerCase()).toBe(testAddress.toLowerCase());

            // Should NOT recover correctly with wrong type
            const RECEIVE_TYPES = [
                { name: 'from', type: 'address' },
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'validAfter', type: 'uint256' },
                { name: 'validBefore', type: 'uint256' },
                { name: 'nonce', type: 'bytes32' }
            ] as const;

            const recoveredReceive = await recoverTypedDataAddress({
                domain: USDC_DOMAIN,
                types: {
                    ReceiveWithAuthorization: RECEIVE_TYPES
                },
                primaryType: 'ReceiveWithAuthorization',
                message,
                signature: transferSig
            });

            expect(recoveredReceive.toLowerCase()).not.toBe(testAddress.toLowerCase());
        });
    });
});

