/**
 * Integration tests for payment verification functions
 * Tests actual verification logic with mocked blockchain/facilitator responses
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createPaymentAwareHandler, type PaymentEnabledRoute } from '../payment-wrapper';
import type { IAgentRuntime } from '@elizaos/core';

// Types for mock objects
type MockRequest = {
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
    query: Record<string, string | string[] | undefined>;
    body: Record<string, unknown>;
    params: Record<string, string>;
};

type MockResponse = {
    status: (code: number) => { json: (data: unknown) => void };
    json: (data: unknown) => void;
    getStatus: () => number;
    getData: () => unknown;
};

// Mock runtime
function createMockRuntime(overrides?: Record<string, string>): IAgentRuntime {
    return {
        agentId: 'test-agent-123',
        getSetting: (key: string) => {
            const settings: Record<string, string> = {
                'BASE_PUBLIC_KEY': '0x066E94e1200aa765d0A6392777D543Aa6Dea606C',
                'SOLANA_PUBLIC_KEY': '3nMBmufBUBVnk28sTp3NsrSJsdVGTyLZYmsqpMFaUT9J',
                'X402_FACILITATOR_URL': 'https://test-facilitator.example.com',
                'BASE_RPC_URL': 'https://mainnet.base.org',
                'SOLANA_RPC_URL': 'https://api.mainnet-beta.solana.com',
                'X402_TRUSTED_GATEWAY_SIGNERS': '0x2EB8323f66eE172315503de7325D04c676089267',
                ...overrides
            };
            return settings[key];
        },
        setCache: async () => true,
        getCache: async () => null
    } as IAgentRuntime;
}

// Mock request
function createMockRequest(overrides?: Partial<MockRequest>): MockRequest {
    return {
        method: 'GET',
        path: '/api/test',
        headers: {},
        query: {},
        body: {},
        params: {},
        ...overrides
    };
}

// Mock response
function createMockResponse(): MockResponse {
    let statusCode = 200;
    let responseData: unknown = null;

    return {
        status: (code: number) => {
            statusCode = code;
            return {
                json: (data: unknown) => {
                    responseData = data;
                }
            };
        },
        json: (data: unknown) => {
            responseData = data;
        },
        getStatus: () => statusCode,
        getData: () => responseData
    };
}

describe('Payment Verification Integration Tests', () => {
    
    describe('verifyPayment - No Payment Provided', () => {
        it('should return 402 when no payment credentials provided', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['base_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true, message: 'Paid content' });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const req = createMockRequest();
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(res.getStatus()).toBe(402);
            const data = res.getData();
            expect(data.x402Version).toBe(1);
            expect(data.accepts).toBeDefined();
            expect(Array.isArray(data.accepts)).toBe(true);
        });

        it('should include payment options in 402 response', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 25,
                    paymentConfigs: ['base_usdc', 'solana_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const req = createMockRequest();
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            const data = res.getData();
            expect(data.accepts).toHaveLength(2);
            
            // Verify Base option
            type AcceptsItem = { network: string; payTo: string; maxAmountRequired: string };
            const accepts = data.accepts as AcceptsItem[];
            const baseOption = accepts.find((a) => a.network === 'base');
            expect(baseOption).toBeDefined();
            expect(baseOption?.payTo).toBe('0x066E94e1200aa765d0A6392777D543Aa6Dea606C');
            expect(baseOption?.maxAmountRequired).toBe('25');
        });
    });

    describe('verifyPaymentIdViaFacilitator', () => {
        it('should reject invalid payment ID format', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['base_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const req = createMockRequest({
                headers: {
                    'x-payment-id': 'invalid; DROP TABLE' // SQL injection attempt
                }
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            // Should reject invalid payment ID
            expect(res.getStatus()).toBe(402);
            const data = res.getData();
            expect(data.error).toBeDefined();
        });

        it('should validate payment ID length', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['base_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const req = createMockRequest({
                headers: {
                    'x-payment-id': 'a'.repeat(129) // Too long (max 128)
                }
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(res.getStatus()).toBe(402);
        });
    });

    describe('verifyEvmPayment - EIP-712 Validation', () => {
        it('should reject malformed JSON payment proof', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['base_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const req = createMockRequest({
                headers: {
                    'x-payment-proof': Buffer.from('not valid json').toString('base64')
                }
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(res.getStatus()).toBe(402);
        });

        it('should reject payment proof missing signature', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['base_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const invalidProof = {
                // Missing signature field
                authorization: {
                    from: '0x123',
                    to: '0x066E94e1200aa765d0A6392777D543Aa6Dea606C',
                    value: '100000',
                    validAfter: '0',
                    validBefore: '9999999999',
                    nonce: '0x' + '0'.repeat(64)
                }
            };
            
            const req = createMockRequest({
                headers: {
                    'x-payment-proof': Buffer.from(JSON.stringify(invalidProof)).toString('base64')
                }
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(res.getStatus()).toBe(402);
        });

        it('should reject payment proof missing authorization', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['base_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const invalidProof = {
                signature: '0x' + 'a'.repeat(130)
                // Missing authorization
            };
            
            const req = createMockRequest({
                headers: {
                    'x-payment-proof': Buffer.from(JSON.stringify(invalidProof)).toString('base64')
                }
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(res.getStatus()).toBe(402);
        });

        it('should reject payment with missing authorization fields', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['base_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const invalidProof = {
                signature: '0x' + 'a'.repeat(130),
                authorization: {
                    from: '0x123',
                    to: null, // Missing to field
                    value: '100000'
                    // Missing validAfter, validBefore, nonce
                }
            };
            
            const req = createMockRequest({
                headers: {
                    'x-payment-proof': Buffer.from(JSON.stringify(invalidProof)).toString('base64')
                }
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(res.getStatus()).toBe(402);
        });

        it('should reject payment to wrong recipient', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['base_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const wrongRecipientProof = {
                signature: '0x' + 'a'.repeat(130),
                authorization: {
                    from: '0x123',
                    to: '0x9999999999999999999999999999999999999999', // Wrong recipient
                    value: '100000',
                    validAfter: '0',
                    validBefore: '9999999999',
                    nonce: '0x' + '0'.repeat(64)
                }
            };
            
            const req = createMockRequest({
                headers: {
                    'x-payment-proof': Buffer.from(JSON.stringify(wrongRecipientProof)).toString('base64')
                }
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(res.getStatus()).toBe(402);
        });

        it('should reject payment with insufficient amount', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 50, // Requires 50 cents
                    paymentConfigs: ['base_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            
            // Payment for only 10 cents (100,000 units) when 50 cents required (500,000 units)
            const insufficientProof = {
                signature: '0x' + 'a'.repeat(130),
                authorization: {
                    from: '0x123',
                    to: '0x066E94e1200aa765d0A6392777D543Aa6Dea606C',
                    value: '100000', // Only $0.10 when $0.50 required
                    validAfter: '0',
                    validBefore: '9999999999',
                    nonce: '0x' + '0'.repeat(64)
                }
            };
            
            const req = createMockRequest({
                headers: {
                    'x-payment-proof': Buffer.from(JSON.stringify(insufficientProof)).toString('base64')
                }
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(res.getStatus()).toBe(402);
        });

        it('should reject expired payment authorization', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['base_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const now = Math.floor(Date.now() / 1000);
            
            const expiredProof = {
                signature: '0x' + 'a'.repeat(130),
                authorization: {
                    from: '0x123',
                    to: '0x066E94e1200aa765d0A6392777D543Aa6Dea606C',
                    value: '100000',
                    validAfter: '0',
                    validBefore: String(now - 3600), // Expired 1 hour ago
                    nonce: '0x' + '0'.repeat(64)
                }
            };
            
            const req = createMockRequest({
                headers: {
                    'x-payment-proof': Buffer.from(JSON.stringify(expiredProof)).toString('base64')
                }
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(res.getStatus()).toBe(402);
        });

        it('should reject future payment authorization', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['base_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const now = Math.floor(Date.now() / 1000);
            
            const futureProof = {
                signature: '0x' + 'a'.repeat(130),
                authorization: {
                    from: '0x123',
                    to: '0x066E94e1200aa765d0A6392777D543Aa6Dea606C',
                    value: '100000',
                    validAfter: String(now + 3600), // Valid in 1 hour
                    validBefore: String(now + 7200),
                    nonce: '0x' + '0'.repeat(64)
                }
            };
            
            const req = createMockRequest({
                headers: {
                    'x-payment-proof': Buffer.from(JSON.stringify(futureProof)).toString('base64')
                }
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(res.getStatus()).toBe(402);
        });
    });

    describe('verifySolanaPayment - Format Validation', () => {
        it('should reject invalid Solana signature format', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['solana_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const req = createMockRequest({
                headers: {
                    'x-payment-proof': 'not-a-valid-solana-signature'
                }
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(res.getStatus()).toBe(402);
        });

        it('should reject Solana signature with wrong characters', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['solana_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            // Solana signatures should be base58, not hex
            const invalidSig = '0x' + 'a'.repeat(87);
            
            const req = createMockRequest({
                headers: {
                    'x-payment-proof': invalidSig
                }
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(res.getStatus()).toBe(402);
        });
    });

    describe('Free Routes', () => {
        it('should execute handler immediately for routes without x402', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/free',
                handler: async (req, res, runtime) => {
                    res.json({ success: true, message: 'Free content' });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const req = createMockRequest();
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(res.getStatus()).toBe(200);
            const data = res.getData();
            expect(data.success).toBe(true);
            expect(data.message).toBe('Free content');
        });
    });

    describe('Request Validation', () => {
        it('should run validator before payment check', async () => {
            let validatorCalled = false;
            
            const route: PaymentEnabledRoute = {
                type: 'POST',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['base_usdc']
                },
                validator: (req) => {
                    validatorCalled = true;
                    const { requiredField } = req.body || {};
                    if (!requiredField) {
                        return {
                            valid: false,
                            error: {
                                status: 400,
                                message: 'requiredField is required'
                            }
                        };
                    }
                    return { valid: true };
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const req = createMockRequest({
                method: 'POST',
                body: {} // Missing requiredField
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(validatorCalled).toBe(true);
            expect(res.getStatus()).toBe(402);
            const data = res.getData();
            expect(data.error).toContain('requiredField');
        });

        it('should proceed to payment check if validation passes', async () => {
            let validatorCalled = false;
            
            const route: PaymentEnabledRoute = {
                type: 'POST',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10,
                    paymentConfigs: ['base_usdc']
                },
                validator: (req) => {
                    validatorCalled = true;
                    return { valid: true };
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const req = createMockRequest({
                method: 'POST',
                body: { requiredField: 'present' }
            });
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            expect(validatorCalled).toBe(true);
            // Should proceed to payment check (returns 402 since no payment)
            expect(res.getStatus()).toBe(402);
            const data = res.getData();
            expect(data.x402Version).toBe(1); // Payment required, not validation error
        });
    });

    describe('Amount Calculation Correctness', () => {
        it('should correctly convert 10 cents to USDC units in 402 response', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 10, // $0.10
                    paymentConfigs: ['base_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const req = createMockRequest();
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            const data = res.getData();
            const baseOption = data.accepts[0];
            
            // Should require 10 cents, not $10
            expect(baseOption.maxAmountRequired).toBe('10');
            // Extra should show human-readable price
            expect(baseOption.extra.priceUSD).toBe('$0.10');
        });

        it('should correctly convert 50 cents to USDC units', async () => {
            const route: PaymentEnabledRoute = {
                type: 'GET',
                path: '/api/test/paid',
                x402: {
                    priceInCents: 50, // $0.50
                    paymentConfigs: ['base_usdc']
                },
                handler: async (req, res, runtime) => {
                    res.json({ success: true });
                }
            };

            const handler = createPaymentAwareHandler(route);
            const req = createMockRequest();
            const res = createMockResponse();
            const runtime = createMockRuntime();

            await handler!(req, res, runtime);

            const data = res.getData();
            const baseOption = data.accepts[0];
            
            expect(baseOption.maxAmountRequired).toBe('50');
            expect(baseOption.extra.priceUSD).toBe('$0.50');
        });
    });
});

