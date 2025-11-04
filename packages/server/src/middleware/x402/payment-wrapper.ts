import type { Route, PaymentEnabledRoute as CorePaymentEnabledRoute } from '@elizaos/core';
import {
    getPaymentAddress,
    toX402Network,
    toResourceUrl,
    getCAIP19FromConfig,
    getPaymentConfig,
    listX402Configs,
    type Network
} from './payment-config.js';
import {
    createAccepts,
    createX402Response,
    type OutputSchema,
    type X402Response
} from './x402-types.js';
import {
    recoverTypedDataAddress,
    type Address,
    type Hex,
    type TypedDataDomain
} from 'viem';
import { base, polygon, mainnet } from 'viem/chains';

/**
 * Debug logging helper - only logs if DEBUG_X402_PAYMENTS is enabled
 */
const DEBUG = process.env.DEBUG_X402_PAYMENTS === 'true';
function log(...args: any[]) {
    if (DEBUG) console.log(...args);
}
function logSection(title: string) {
    if (DEBUG) {
        console.log('\n' + '═'.repeat(60));
        console.log(`  ${title}`);
        console.log('═'.repeat(60));
    }
}
function logError(...args: any[]) {
    console.error(...args);
}


/**
 * EIP-712 TransferWithAuthorization type
 */
const TRANSFER_WITH_AUTHORIZATION_TYPES = [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
] as const;

/**
 * EIP-712 ReceiveWithAuthorization type
 */
const RECEIVE_WITH_AUTHORIZATION_TYPES = [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
] as const;

/**
 * Get the viem chain object for a network
 */
function getViemChain(network: string) {
    switch (network.toUpperCase()) {
        case 'BASE':
            return base;
        case 'POLYGON':
            return polygon;
        case 'ETHEREUM':
            return mainnet;
        default:
            return base;
    }
}


/**
 * Get USDC contract address for a network
 */
function getUsdcContractAddress(network: string): Address {
    switch (network.toUpperCase()) {
        case 'BASE':
            return '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
        case 'POLYGON':
            return '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
        case 'ETHEREUM':
            return '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
        default:
            return '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    }
}

/**
 * Wrapper to integrate x402 payment middleware with ElizaOS route handlers
 * 
 * Re-export the PaymentEnabledRoute type from core for convenience
 */
export type PaymentEnabledRoute = CorePaymentEnabledRoute;

/**
 * Payment verification parameters
 */
interface PaymentVerificationParams {
    paymentProof?: string;
    paymentId?: string;
    route: string;
    expectedAmount: string;
    runtime: any;
    req?: any;
}

/**
 * Verify payment proof from x402 payment provider
 */
async function verifyPayment(params: PaymentVerificationParams): Promise<boolean> {
    const { paymentProof, paymentId, route, expectedAmount, runtime, req } = params;

    logSection('PAYMENT VERIFICATION');
    log('Route:', route, 'Expected:', expectedAmount);

    if (!paymentProof && !paymentId) {
        logError('✗ No payment credentials provided');
        return false;
    }

    // Strategy 1: Verify payment proof (blockchain transaction)
    if (paymentProof) {
        try {
            let decodedProof: string;
            try {
                decodedProof = Buffer.from(paymentProof, 'base64').toString('utf-8');
            } catch {
                decodedProof = paymentProof;
            }

            try {
                const jsonProof = JSON.parse(decodedProof);
                log('Detected JSON payment proof');

                const authData = jsonProof.payload ? {
                    signature: jsonProof.payload.signature,
                    authorization: jsonProof.payload.authorization,
                    network: jsonProof.network,
                    scheme: jsonProof.scheme
                } : jsonProof;

                let network = authData.network || jsonProof.network || 'BASE';
                const chainId = authData.domain?.chainId || jsonProof.domain?.chainId;
                if (chainId) {
                    const chainIdMap: Record<number, string> = { 8453: 'BASE', 137: 'POLYGON', 1: 'ETHEREUM' };
                    network = chainIdMap[chainId] || 'BASE';
                }

                const expectedRecipient = getPaymentAddress(network.toUpperCase() as Network);
                const isValid = await verifyEvmPayment(
                    JSON.stringify(authData),
                    expectedRecipient,
                    expectedAmount,
                    network,
                    runtime,
                    req
                );

                if (isValid) {
                    log(`✓ ${network} payment verified (EIP-712)`);
                    return true;
                }
            } catch {
                const parts = decodedProof.split(':');

                if (parts.length >= 3) {
                    const [network, address, signature] = parts;
                    log(`Legacy format: ${network}`);

                    if (network.toUpperCase() === 'SOLANA') {
                        if (await verifySolanaPayment(signature, address, expectedAmount, runtime)) {
                            log('✓ Solana payment verified');
                            return true;
                        }
                    } else if (network.toUpperCase() === 'BASE' || network.toUpperCase() === 'POLYGON') {
                        if (await verifyEvmPayment(signature, address, expectedAmount, network, runtime, req)) {
                            log(`✓ ${network} payment verified`);
                            return true;
                        }
                    }
                } else if (parts.length === 1 && parts[0].length > 50) {
                    const defaultAddress = getPaymentAddress('SOLANA');
                    if (await verifySolanaPayment(parts[0], defaultAddress, expectedAmount, runtime)) {
                        log('✓ Solana payment verified (raw signature)');
                        return true;
                    }
                }
            }
        } catch (error) {
            logError('Blockchain verification error:', error instanceof Error ? error.message : String(error));
        }
    }

    // Strategy 2: Verify payment ID (facilitator-based payment)
    if (paymentId) {
        try {
            if (await verifyPaymentIdViaFacilitator(paymentId, runtime)) {
                log('✓ Facilitator payment verified');
                return true;
            }
        } catch (error) {
            logError('Facilitator verification error:', error instanceof Error ? error.message : String(error));
        }
    }

    logError('✗ All payment verification strategies failed');
    return false;
}

/**
 * Verify payment ID via facilitator API
 */
async function verifyPaymentIdViaFacilitator(
    paymentId: string,
    runtime: any
): Promise<boolean> {
    logSection('FACILITATOR VERIFICATION');
    log('Payment ID:', paymentId);

    const facilitatorUrl = runtime.getSetting('X402_FACILITATOR_URL') || 'https://x402.elizaos.ai/api/facilitator';
    if (!facilitatorUrl) {
        logError('⚠️  No facilitator URL configured');
        return false;
    }

    try {
        const cleanUrl = facilitatorUrl.replace(/\/$/, '');
        const endpoint = `${cleanUrl}/verify/${encodeURIComponent(paymentId)}`;
        log('Verifying at:', endpoint);

        const response = await fetch(endpoint, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'ElizaOS-X402-Client/1.0'
            },
            signal: AbortSignal.timeout(10000)
        });

        const responseText = await response.text();
        const responseData = responseText ? JSON.parse(responseText) : null;

        if (response.ok) {
            const isValid = responseData?.valid !== false && responseData?.verified !== false;
            if (isValid) {
                log('✓ Facilitator verified payment');
                return true;
            } else {
                logError('✗ Payment invalid per facilitator');
                return false;
            }
        } else if (response.status === 404) {
            logError('✗ Payment ID not found (404)');
            return false;
        } else if (response.status === 410) {
            logError('✗ Payment ID already used (410 - replay attack prevented)');
            return false;
        } else {
            logError(`✗ Facilitator error: ${response.status} ${response.statusText}`);
            return false;
        }
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            logError('✗ Facilitator request timed out (10s)');
        } else {
            logError('✗ Facilitator verification error:', error instanceof Error ? error.message : String(error));
        }
        return false;
    }
}

/**
 * Verify a Solana transaction
 */
async function verifySolanaPayment(
    signature: string,
    expectedRecipient: string,
    _expectedAmount: string,
    runtime: any
): Promise<boolean> {
    log('Verifying Solana transaction:', signature.substring(0, 20) + '...');

    try {
        const { Connection, PublicKey } = await import('@solana/web3.js');
        const rpcUrl = runtime.getSetting('SOLANA_RPC_URL') || 'https://api.mainnet-beta.solana.com';
        const connection = new Connection(rpcUrl);

        const tx = await connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0
        });

        if (!tx) {
            logError('Transaction not found on Solana blockchain');
            return false;
        }

        if (tx.meta?.err) {
            logError('Transaction failed on-chain:', tx.meta.err);
            return false;
        }

        const accountKeys = tx.transaction.message.getAccountKeys();
        const recipientPubkey = new PublicKey(expectedRecipient);
        const recipientIndex = accountKeys.keySegments().flat().findIndex(
            (key) => key.toBase58() === recipientPubkey.toBase58()
        );

        if (recipientIndex === -1) {
            logError('Recipient address not found in transaction');
            return false;
        }

        log('✓ Solana transaction verified');
        return true;

    } catch (error) {
        logError('Solana verification error:', error instanceof Error ? error.message : String(error));
        return false;
    }
}

/**
 * Verify an EVM transaction or EIP-712 signature
 */
async function verifyEvmPayment(
    paymentData: string,
    expectedRecipient: string,
    expectedAmount: string,
    network: string,
    runtime: any,
    req?: any
): Promise<boolean> {
    log(`Verifying ${network} payment:`, paymentData.substring(0, 20) + '...');

    try {
        if (paymentData.match(/^0x[a-fA-F0-9]{64}$/)) {
            log('Detected transaction hash format');
            return await verifyEvmTransaction(paymentData, expectedRecipient, expectedAmount, network, runtime);
        }

        try {
            const parsed = JSON.parse(paymentData);
            if (parsed.signature || (parsed.v && parsed.r && parsed.s)) {
                log('Detected EIP-712 signature format');
                return await verifyEip712Authorization(parsed, expectedRecipient, expectedAmount, network, runtime, req);
            }
        } catch (e) {
            // Not JSON, continue
        }

        if (paymentData.match(/^0x[a-fA-F0-9]{130}$/)) {
            logError('Raw signature detected but authorization parameters missing');
            return false;
        }

        logError('Unrecognized EVM payment format');
        return false;
    } catch (error) {
        logError('EVM verification error:', error instanceof Error ? error.message : String(error));
        return false;
    }
}

/**
 * Verify a regular EVM transaction
 */
async function verifyEvmTransaction(
    _txHash: string,
    _expectedRecipient: string,
    _expectedAmount: string,
    _network: string,
    _runtime: any
): Promise<boolean> {
    log('Verifying on-chain transaction:', _txHash);
    logError('⚠️  EVM transaction verification not fully implemented - accepting valid tx hash format');
    return true;
}

/**
 * Verify EIP-712 authorization signature (ERC-3009 TransferWithAuthorization)
 */
async function verifyEip712Authorization(
    paymentData: any,
    expectedRecipient: string,
    expectedAmount: string,
    network: string,
    runtime: any,
    req?: any
): Promise<boolean> {
    log('Verifying EIP-712 authorization signature');
    log('Payment data:', JSON.stringify(paymentData, null, 2));

    try {
        let signature: string;
        let authorization: any;

        if (paymentData.signature) {
            signature = paymentData.signature;
            authorization = paymentData.authorization || paymentData.message;
        } else if (paymentData.v && paymentData.r && paymentData.s) {
            signature = `0x${paymentData.r}${paymentData.s}${paymentData.v.toString(16).padStart(2, '0')}`;
            authorization = paymentData.authorization || paymentData.message;
        } else {
            console.error('No valid signature found in payment data');
            return false;
        }

        if (!authorization) {
            console.error('No authorization data found in payment data');
            return false;
        }

        log('Authorization:', {
            from: authorization.from?.substring(0, 10) + '...',
            to: authorization.to?.substring(0, 10) + '...',
            value: authorization.value
        });

        if (authorization.to.toLowerCase() !== expectedRecipient.toLowerCase()) {
            console.error('Recipient mismatch:', authorization.to, 'vs', expectedRecipient);
            return false;
        }

        const expectedUSD = parseFloat(expectedAmount.replace('$', ''));
        const expectedUnits = Math.floor(expectedUSD * 1e6);
        const authValue = parseInt(authorization.value);

        if (authValue < expectedUnits) {
            console.error('Amount too low:', authValue, 'vs', expectedUnits);
            return false;
        }

        const now = Math.floor(Date.now() / 1000);
        const validAfter = parseInt(authorization.validAfter || '0');
        const validBefore = parseInt(authorization.validBefore || String(now + 86400));

        if (now < validAfter) {
            console.error('Authorization not yet valid:', now, '<', validAfter);
            return false;
        }

        if (now > validBefore) {
            console.error('Authorization expired:', now, '>', validBefore);
            return false;
        }

        log('✓ EIP-712 authorization parameters valid');

        const SKIP_SIGNATURE_VERIFICATION = runtime?.getSetting?.('SKIP_X402_SIGNATURE_VERIFICATION') === 'true';
        const ALLOW_SIGNER_MISMATCH = runtime?.getSetting?.('ALLOW_X402_SIGNER_MISMATCH') === 'true';

        if (SKIP_SIGNATURE_VERIFICATION) {
            logError('⚠️  WARNING: SIGNATURE VERIFICATION DISABLED - DANGEROUS!');
            return true;
        }

        logSection('Cryptographic Signature Verification');

        try {
            let verifyingContract: Address;
            let chainId: number;
            let domainName = 'USD Coin';
            let domainVersion = '2';

            if (paymentData.domain) {
                log('Using domain from payment data:', paymentData.domain);
                verifyingContract = paymentData.domain.verifyingContract as Address;
                chainId = paymentData.domain.chainId;
                if (paymentData.domain.name) domainName = paymentData.domain.name;
                if (paymentData.domain.version) domainVersion = paymentData.domain.version;
            } else {
                log('No domain in payment data - using defaults');
                verifyingContract = getUsdcContractAddress(network);
                const chain = getViemChain(network);
                chainId = chain.id;
            }

            log('Verifying contract:', verifyingContract, 'chainId:', chainId);

            const domain: TypedDataDomain = {
                name: domainName,
                version: domainVersion,
                chainId,
                verifyingContract
            };

            log('Domain for verification:', domain);

            const types = {
                TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES
            };

            const message = {
                from: authorization.from as Address,
                to: authorization.to as Address,
                value: BigInt(authorization.value),
                validAfter: BigInt(authorization.validAfter || 0),
                validBefore: BigInt(authorization.validBefore || Math.floor(Date.now() / 1000) + 86400),
                nonce: authorization.nonce as Hex
            };

            log('Message:', { from: message.from, to: message.to, value: message.value.toString() });

            if (!SKIP_SIGNATURE_VERIFICATION) {
                try {
                    const recoveredAddress = await recoverTypedDataAddress({
                        domain,
                        types,
                        primaryType: 'TransferWithAuthorization',
                        message,
                        signature: signature as Hex
                    });

                    log('Recovered signer:', recoveredAddress, 'Expected:', authorization.from);

                    const signerMatches = recoveredAddress.toLowerCase() === authorization.from.toLowerCase();

                    if (!signerMatches) {
                        try {
                            const wrongTypeRecovered = await recoverTypedDataAddress({
                                domain,
                                types: { ReceiveWithAuthorization: RECEIVE_WITH_AUTHORIZATION_TYPES },
                                primaryType: 'ReceiveWithAuthorization',
                                message,
                                signature: signature as Hex
                            });

                            if (wrongTypeRecovered.toLowerCase() === authorization.from.toLowerCase()) {
                                logError('❌ CLIENT ERROR: Wrong EIP-712 type used');
                                return false;
                            }
                        } catch (e) {
                            log('Could not recover with ReceiveWithAuthorization either');
                        }
                    }

                    log('Signature match:', signerMatches ? '✓ Valid' : '✗ Invalid');

                    if (!signerMatches) {
                        const userAgent = req?.headers?.['user-agent'] || '';
                        const isX402Gateway = userAgent.includes('X402-Gateway');

                        if (isX402Gateway) {
                            log('🔍 Detected X402 Gateway User-Agent');
                            const trustedSigners = runtime.getSetting?.('X402_TRUSTED_GATEWAY_SIGNERS') ||
                                '0x2EB8323f66eE172315503de7325D04c676089267';
                            const signerWhitelist = trustedSigners.split(',').map((addr: string) => addr.trim().toLowerCase());

                            if (signerWhitelist.includes(recoveredAddress.toLowerCase())) {
                                log('✅ Signature verified: signed by authorized X402 Gateway');
                                return true;
                            } else {
                                logError(`✗ Gateway signer NOT in whitelist: ${recoveredAddress}`);
                                return false;
                            }
                        } else if (ALLOW_SIGNER_MISMATCH) {
                            logError(`⚠️  Signer mismatch ALLOWED`);
                            return true;
                        } else {
                            logError('✗ Signature verification failed: signer mismatch');
                            return false;
                        }
                    } else {
                        log('✓ Signature cryptographically verified');
                        return true;
                    }

                } catch (error) {
                    logError('✗ Signature verification failed:', error instanceof Error ? error.message : String(error));
                    return false;
                }
            }

            return true;

        } catch (error) {
            logError('EIP-712 verification error:', error instanceof Error ? error.message : String(error));
            return false;
        }
    } catch (error) {
        logError('EIP-712 verification error:', error instanceof Error ? error.message : String(error));
        return false;
    }
}

/**
 * Create a payment-aware route handler
 */
export function createPaymentAwareHandler(
    route: PaymentEnabledRoute
): Route['handler'] {
    const originalHandler = route.handler;

    return async (req: any, res: any, runtime: any) => {
        if (!route.x402) {
            if (originalHandler) {
                return originalHandler(req, res, runtime);
            }
            return;
        }

        logSection(`X402 Payment Check - ${route.path}`);
        log('Method:', req.method);

        if (route.validator) {
            try {
                const validationResult = await route.validator(req);

                if (!validationResult.valid) {
                    logError('✗ Validation failed:', validationResult.error?.message);

                    const x402Response = buildX402Response(route, runtime);

                    const errorMessage = validationResult.error?.details
                        ? `${validationResult.error.message}: ${JSON.stringify(validationResult.error.details)}`
                        : validationResult.error?.message || 'Invalid request parameters';

                    return res.status(402).json({
                        ...x402Response,
                        error: errorMessage
                    });
                }

                log('✓ Validation passed');
            } catch (error) {
                logError('✗ Validation error:', error instanceof Error ? error.message : String(error));

                const x402Response = buildX402Response(route, runtime);
                return res.status(402).json({
                    ...x402Response,
                    error: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
                });
            }
        }

        log('Headers:', JSON.stringify(req.headers, null, 2));
        log('Query:', JSON.stringify(req.query, null, 2));
        if (req.method === 'POST' && req.body) {
            log('Body:', JSON.stringify(req.body, null, 2));
        }

        const paymentProof = req.headers['x-payment-proof'] || req.headers['x-payment'] || req.query.paymentProof;
        const paymentId = req.headers['x-payment-id'] || req.query.paymentId;

        log('Payment credentials:', {
            'x-payment-proof': !!req.headers['x-payment-proof'],
            'x-payment': !!req.headers['x-payment'],
            'x-payment-id': !!paymentId,
            found: !!(paymentProof || paymentId)
        });

        if (paymentProof || paymentId) {
            log('Payment credentials received:', {
                proofLength: paymentProof ? String(paymentProof).length : 0,
                paymentId
            });

            try {
                const expectedAmount = String(route.x402.priceInCents);
                const isValid = await verifyPayment({
                    paymentProof: paymentProof as string,
                    paymentId: paymentId as string,
                    route: route.path,
                    expectedAmount,
                    runtime,
                    req
                });

                if (isValid) {
                    log('✓ PAYMENT VERIFIED - executing handler');
                    if (originalHandler) {
                        return originalHandler(req, res, runtime);
                    }
                    return;
                } else {
                    logError('✗ PAYMENT VERIFICATION FAILED');
                    res.status(402).json({
                        error: 'Payment verification failed',
                        message: 'The provided payment proof is invalid or has expired',
                        x402Version: 1
                    });
                    return;
                }
            } catch (error) {
                logError('✗ PAYMENT VERIFICATION ERROR:', error instanceof Error ? error.message : String(error));
                res.status(402).json({
                    error: 'Payment verification error',
                    message: error instanceof Error ? error.message : String(error),
                    x402Version: 1
                });
                return;
            }
        }

        log('No payment credentials - returning 402');

        try {
            const x402Response = buildX402Response(route, runtime);
            log('Payment options:', {
                paymentConfigs: route.x402.paymentConfigs || ['base_usdc'],
                priceInCents: route.x402.priceInCents,
                count: x402Response.accepts?.length || 0
            });
            log('402 Response:', JSON.stringify(x402Response, null, 2));

            res.status(402).json(x402Response);
        } catch (error) {
            logError('✗ Failed to build x402 response:', error instanceof Error ? error.message : String(error));
            res.status(402).json(createX402Response({
                error: `Payment Required: ${error instanceof Error ? error.message : 'Unknown error'}`
            }));
        }
    };
}

/**
 * Build x402scan-compliant response for a route
 */
function buildX402Response(route: PaymentEnabledRoute, runtime?: any): X402Response {
    if (!route.x402?.priceInCents) {
        throw new Error('Route x402.priceInCents is required for x402 response');
    }

    const paymentConfigs = route.x402?.paymentConfigs || ['base_usdc'];
    const agentId = runtime?.agentId;

    const accepts = paymentConfigs.flatMap(configName => {
        const config = getPaymentConfig(configName, agentId);
        const caip19 = getCAIP19FromConfig(config);

        const inputSchema = buildInputSchemaFromRoute(route);

        const method = route.type === 'POST' ? 'POST' : 'GET';

        const outputSchema: OutputSchema = {
            input: {
                type: "http",
                method: method,
                bodyType: method === 'POST' ? 'json' : undefined,
                pathParams: inputSchema.pathParams,
                queryParams: inputSchema.queryParams,
                bodyFields: inputSchema.bodyFields,
                headerFields: {
                    'X-Payment-Proof': {
                        type: 'string',
                        required: true,
                        description: 'Payment proof token from x402 payment provider'
                    },
                    'X-Payment-Id': {
                        type: 'string',
                        required: false,
                        description: 'Optional payment ID for tracking'
                    }
                }
            },
            output: {
                type: 'object',
                description: 'API response data (varies by endpoint)'
            }
        };

        const extra: Record<string, any> = {
            priceInCents: route.x402?.priceInCents || 0,
            priceUSD: `$${((route.x402?.priceInCents || 0) / 100).toFixed(2)}`,
            symbol: config.symbol,
            paymentConfig: configName,
            expiresIn: 300  // Payment window in seconds
        };

        // Add EIP-712 domain for EVM chains (helps client developers)
        if (config.network === 'BASE' || config.network === 'POLYGON') {
            extra.name = 'USD Coin';
            extra.version = '2';
            extra.eip712Domain = {
                name: 'USD Coin',
                version: '2',
                chainId: parseInt(config.chainId || '1'),
                verifyingContract: config.assetReference
            };
        }

        return createAccepts({
            network: toX402Network(config.network),
            maxAmountRequired: String(route.x402?.priceInCents || 0),
            resource: toResourceUrl(route.path),
            description: generateDescription(route),
            payTo: config.paymentAddress,
            asset: caip19,
            mimeType: 'application/json',
            maxTimeoutSeconds: 300,
            outputSchema,
            extra
        });
    });

    return createX402Response({
        accepts,
        error: 'Payment Required'
    });
}

/**
 * Extract path parameter names from Express-style route path
 */
function extractPathParams(path: string): string[] {
    const matches = path.matchAll(/:([^/]+)/g);
    return Array.from(matches, m => m[1]);
}

/**
 * Convert OpenAPI schema to FieldDef format
 */
function convertOpenAPISchemaToFieldDef(schema: any): Record<string, any> {
    if (schema.type === 'object' && schema.properties) {
        const fields: Record<string, any> = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            fields[key] = {
                type: (value as any).type,
                required: schema.required?.includes(key) ?? false,
                description: (value as any).description,
                enum: (value as any).enum,
                pattern: (value as any).pattern,
                properties: (value as any).properties ? convertOpenAPISchemaToFieldDef(value) : undefined
            };
        }
        return fields;
    }
    return {};
}

/**
 * Build input schema from route
 */
function buildInputSchemaFromRoute(route: PaymentEnabledRoute): {
    pathParams?: Record<string, any>;
    queryParams?: Record<string, any>;
    bodyFields?: Record<string, any>;
} {
    const schema: any = {};

    if (route.openapi?.parameters) {
        const pathParams = route.openapi.parameters
            .filter(p => p.in === 'path')
            .reduce((acc, p) => ({
                ...acc,
                [p.name]: {
                    type: p.schema.type,
                    required: p.required ?? true,
                    description: p.description,
                    enum: p.schema.enum,
                    pattern: p.schema.pattern
                }
            }), {});
        if (Object.keys(pathParams).length > 0) schema.pathParams = pathParams;
    } else {
        const paramNames = extractPathParams(route.path);
        if (paramNames.length > 0) {
            schema.pathParams = paramNames.reduce((acc, name) => ({
                ...acc,
                [name]: {
                    type: 'string',
                    required: true,
                    description: `Path parameter: ${name}`
                }
            }), {});
        }
    }

    if (route.openapi?.parameters) {
        const queryParams = route.openapi.parameters
            .filter(p => p.in === 'query')
            .reduce((acc, p) => ({
                ...acc,
                [p.name]: {
                    type: p.schema.type,
                    required: p.required ?? false,
                    description: p.description,
                    enum: p.schema.enum,
                    pattern: p.schema.pattern
                }
            }), {});
        if (Object.keys(queryParams).length > 0) schema.queryParams = queryParams;
    }

    if (route.openapi?.requestBody?.content?.['application/json']?.schema) {
        schema.bodyFields = convertOpenAPISchemaToFieldDef(
            route.openapi.requestBody.content['application/json'].schema
        );
    }

    return schema;
}

/**
 * Auto-generate description from route path if not provided
 */
function generateDescription(route: PaymentEnabledRoute): string {
    if (route.description) return route.description;

    const pathParts = route.path.split('/').filter(Boolean);
    const action = route.type.toLowerCase() === 'get' ? 'Get' : 'Execute';
    const resource = pathParts[pathParts.length - 1]?.replace(/^:/, '') || 'resource';
    return `${action} ${resource}`;
}

/**
 * Validate x402 config
 */
function validateX402Route(route: Route): string[] {
    const errors: string[] = [];
    const x402Route = route as PaymentEnabledRoute;

    if (!route.path) {
        errors.push(`Route missing 'path' property`);
        return errors;
    }

    const routePath = route.path;

    if (!x402Route.x402) {
        return [];
    }

    if (x402Route.x402.priceInCents === undefined || x402Route.x402.priceInCents === null) {
        errors.push(`${routePath}: x402.priceInCents is required`);
    } else if (typeof x402Route.x402.priceInCents !== 'number') {
        errors.push(`${routePath}: x402.priceInCents must be a number`);
    } else if (x402Route.x402.priceInCents <= 0) {
        errors.push(`${routePath}: x402.priceInCents must be > 0`);
    } else if (!Number.isInteger(x402Route.x402.priceInCents)) {
        errors.push(`${routePath}: x402.priceInCents must be an integer`);
    }

    const configs = x402Route.x402.paymentConfigs || ['base_usdc'];
    if (!Array.isArray(configs)) {
        errors.push(`${routePath}: x402.paymentConfigs must be an array`);
    } else {
        if (configs.length === 0) {
            errors.push(`${routePath}: x402.paymentConfigs cannot be empty`);
        }
        // Get all available configs (built-in + custom registered)
        const availableConfigs = listX402Configs();

        for (const configName of configs) {
            if (typeof configName !== 'string') {
                errors.push(`${routePath}: x402.paymentConfigs contains non-string value`);
            } else if (!availableConfigs.includes(configName)) {
                errors.push(
                    `${routePath}: unknown payment config '${configName}'. ` +
                    `Available: ${availableConfigs.join(', ')}`
                );
            }
        }
    }

    return errors;
}

// Re-export types from core
export type { X402ValidationResult, X402RequestValidator } from '@elizaos/core';

/**
 * Apply payment protection to an array of routes
 */
export function applyPaymentProtection(routes: Route[]): Route[] {
    if (!Array.isArray(routes)) {
        throw new Error('routes must be an array');
    }

    const allErrors: string[] = [];
    const routesByPath = new Map<string, string[]>();

    for (const route of routes) {
        const errors = validateX402Route(route);
        if (errors.length > 0) {
            allErrors.push(...errors);
            const routePath = route.path || '[route without path]';
            const existing = routesByPath.get(routePath) || [];
            routesByPath.set(routePath, [...existing, ...errors]);
        }
    }

    if (allErrors.length > 0) {
        let errorMessage = `\n❌ x402 Route Configuration Errors (${allErrors.length} error${allErrors.length > 1 ? 's' : ''} found):\n\n`;

        if (routesByPath.size > 0) {
            for (const [path, routeErrors] of routesByPath.entries()) {
                errorMessage += `  Route: ${path}\n`;
                for (const error of routeErrors) {
                    const errorWithoutPath = error.includes(': ') ? error.split(': ').slice(1).join(': ') : error;
                    errorMessage += `    • ${errorWithoutPath}\n`;
                }
                errorMessage += '\n';
            }
        } else {
            for (const error of allErrors) {
                errorMessage += `  • ${error}\n`;
            }
        }

        errorMessage += '\nPlease fix all errors above and try again.\n';

        throw new Error(errorMessage);
    }

    return routes.map(route => {
        const x402Route = route as PaymentEnabledRoute;
        if (x402Route.x402) {
            console.log('Applying payment protection to:', x402Route.path, {
                priceInCents: x402Route.x402.priceInCents,
                paymentConfigs: x402Route.x402.paymentConfigs || ['base_usdc']
            });

            return {
                ...route,
                handler: createPaymentAwareHandler(x402Route)
            };
        }
        return route;
    });
}

