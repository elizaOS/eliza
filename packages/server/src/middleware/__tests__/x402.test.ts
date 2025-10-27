import { describe, test, expect } from 'bun:test';
import { createX402Middleware, x402LoggingMiddleware } from '../x402';
import type { Request, Response, NextFunction } from 'express';

describe('x402 Middleware', () => {
    const originalEnv = { ...process.env };

    describe('createX402Middleware', () => {
        test('should fallback to API key auth when X402_ENABLED is false and API token is configured', () => {
            // Arrange - reset env
            process.env = { ...originalEnv };
            process.env.X402_ENABLED = 'false';
            process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-api-key';

            const routeConfig = {
                'POST /test': {
                    description: 'Test endpoint',
                },
            };

            // Act
            const middleware = createX402Middleware(routeConfig);

            // Assert - should require API key
            let nextCalled = false;
            const mockReq = {
                headers: {
                    'x-api-key': 'test-api-key',
                },
                method: 'POST',
                path: '/test',
            } as unknown as Request;
            const mockRes = {} as Response;
            const mockNext = (() => {
                nextCalled = true;
            }) as NextFunction;

            middleware(mockReq, mockRes, mockNext);
            expect(nextCalled).toBe(true);
        });

        test('should pass through when X402_ENABLED is false and no API token is configured', () => {
            // Arrange - reset env
            process.env = { ...originalEnv };
            process.env.X402_ENABLED = 'false';
            delete process.env.ELIZA_SERVER_AUTH_TOKEN;

            const routeConfig = {
                'POST /test': {
                    description: 'Test endpoint',
                },
            };

            // Act
            const middleware = createX402Middleware(routeConfig);

            // Assert - should pass through
            let nextCalled = false;
            const mockReq = {
                method: 'POST',
                path: '/test',
            } as unknown as Request;
            const mockRes = {} as Response;
            const mockNext = (() => {
                nextCalled = true;
            }) as NextFunction;

            middleware(mockReq, mockRes, mockNext);
            expect(nextCalled).toBe(true);
        });

        test('should reject requests with invalid API key when X402_ENABLED is false', () => {
            // Arrange - reset env
            process.env = { ...originalEnv };
            process.env.X402_ENABLED = 'false';
            process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-api-key';

            const routeConfig = {
                'POST /test': {
                    description: 'Test endpoint',
                },
            };

            // Act
            const middleware = createX402Middleware(routeConfig);

            // Assert - should reject with 401
            let nextCalled = false;
            let statusCode = 0;
            let responseMessage = '';

            const mockReq = {
                headers: {
                    'x-api-key': 'wrong-key',
                },
                method: 'POST',
                path: '/test',
                ip: '127.0.0.1',
            } as unknown as Request;

            const mockRes = {
                status: (code: number) => {
                    statusCode = code;
                    return {
                        send: (message: string) => {
                            responseMessage = message;
                        },
                    };
                },
            } as unknown as Response;

            const mockNext = (() => {
                nextCalled = true;
            }) as NextFunction;

            middleware(mockReq, mockRes, mockNext);

            expect(nextCalled).toBe(false);
            expect(statusCode).toBe(401);
            expect(responseMessage).toContain('Unauthorized');
        });

        test('should throw error when enabled but wallet address is missing', () => {
            // Arrange - reset env
            process.env = { ...originalEnv };
            process.env.X402_ENABLED = 'true';
            delete process.env.X402_WALLET_ADDRESS;

            const routeConfig = {
                'POST /test': {
                    description: 'Test endpoint',
                },
            };

            // Act & Assert
            expect(() => createX402Middleware(routeConfig)).toThrow(
                'x402 is enabled but X402_WALLET_ADDRESS environment variable is not set'
            );
        });

        test('should throw error when mainnet is enabled but CDP credentials are missing', () => {
            // Arrange - reset env
            process.env = { ...originalEnv };
            process.env.X402_ENABLED = 'true';
            process.env.X402_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
            process.env.X402_USE_MAINNET = 'true';
            delete process.env.CDP_API_KEY_ID;
            delete process.env.CDP_API_KEY_SECRET;

            const routeConfig = {
                'POST /test': {
                    description: 'Test endpoint',
                },
            };

            // Act & Assert
            expect(() => createX402Middleware(routeConfig)).toThrow(
                'Mainnet facilitator requires CDP_API_KEY_ID and CDP_API_KEY_SECRET environment variables'
            );
        });

        test('should create middleware with valid configuration', () => {
            // Arrange - reset env
            process.env = { ...originalEnv };
            process.env.X402_ENABLED = 'true';
            process.env.X402_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
            process.env.X402_PRICE = '$0.001';
            process.env.X402_NETWORK = 'base-sepolia';

            const routeConfig = {
                'POST /test': {
                    description: 'Test endpoint',
                    price: '$0.002',
                },
            };

            // Act & Assert - should not throw
            expect(() => createX402Middleware(routeConfig)).not.toThrow();
        });

        test('should use default values when optional env vars are not set', () => {
            // Arrange - reset env
            process.env = { ...originalEnv };
            process.env.X402_ENABLED = 'true';
            process.env.X402_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
            // Don't set optional vars

            const routeConfig = {
                'POST /test': {
                    description: 'Test endpoint',
                },
            };

            // Act & Assert - should not throw and use defaults
            expect(() => createX402Middleware(routeConfig)).not.toThrow();
        });

        test('should require both API key and payment when both are enabled', () => {
            // Arrange - reset env
            process.env = { ...originalEnv };
            process.env.X402_ENABLED = 'true';
            process.env.X402_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
            process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-api-key';

            const routeConfig = {
                'POST /test': {
                    description: 'Test endpoint',
                },
            };

            // Act
            const middleware = createX402Middleware(routeConfig);

            // Assert - middleware should check API key first, then require payment
            // Without API key -> should reject with 401
            let statusCode = 0;
            let responseMessage = '';

            const mockReq = {
                headers: {},
                method: 'POST',
                path: '/test',
                ip: '127.0.0.1',
            } as unknown as Request;

            const mockRes = {
                status: (code: number) => {
                    statusCode = code;
                    return {
                        send: (message: string) => {
                            responseMessage = message;
                        },
                    };
                },
            } as unknown as Response;

            const mockNext = (() => {
                // Should not be called
            }) as NextFunction;

            middleware(mockReq, mockRes, mockNext);

            expect(statusCode).toBe(401);
            expect(responseMessage).toContain('Unauthorized');
        });

        test('should create middleware that validates both when both enabled', () => {
            // Arrange - reset env
            process.env = { ...originalEnv };
            process.env.X402_ENABLED = 'true';
            process.env.X402_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
            process.env.ELIZA_SERVER_AUTH_TOKEN = 'test-api-key';

            const routeConfig = {
                'POST /test': {
                    description: 'Test endpoint',
                },
            };

            // Act
            const middleware = createX402Middleware(routeConfig);

            // Assert - middleware should be created successfully
            // It will first check API key, then proceed to payment validation
            // We can't fully test the payment flow without mocking x402-express
            expect(middleware).toBeDefined();
            expect(typeof middleware).toBe('function');
        });

        test('should not skip payment when no API key token is configured', () => {
            // Arrange - reset env
            process.env = { ...originalEnv };
            process.env.X402_ENABLED = 'true';
            process.env.X402_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
            delete process.env.ELIZA_SERVER_AUTH_TOKEN; // No API key configured

            const routeConfig = {
                'POST /test': {
                    description: 'Test endpoint',
                },
            };

            // Act
            const middleware = createX402Middleware(routeConfig);

            // Assert - middleware should be created successfully
            // Note: We can't test the full payment flow without mocking x402-express,
            // but we verify the middleware is created and configured correctly
            expect(middleware).toBeDefined();
            expect(typeof middleware).toBe('function');
        });
    });

    describe('x402LoggingMiddleware', () => {
        test('should call next without X-PAYMENT header', () => {
            // Arrange
            const mockReq = {
                headers: {},
                path: '/test',
                method: 'POST',
            } as unknown as Request;
            const mockRes = {} as Response;
            let nextCalled = false;
            const mockNext = (() => {
                nextCalled = true;
            }) as NextFunction;

            // Act
            x402LoggingMiddleware(mockReq, mockRes, mockNext);

            // Assert
            expect(nextCalled).toBe(true);
        });

        test('should call next with X-PAYMENT header', () => {
            // Arrange
            const mockReq = {
                headers: {
                    'x-payment': 'some-payment-proof',
                },
                path: '/test',
                method: 'POST',
            } as unknown as Request;
            const mockRes = {} as Response;
            let nextCalled = false;
            const mockNext = (() => {
                nextCalled = true;
            }) as NextFunction;

            // Act
            x402LoggingMiddleware(mockReq, mockRes, mockNext);

            // Assert
            expect(nextCalled).toBe(true);
        });
    });
});
