import type { Route, PaymentEnabledRoute as CorePaymentEnabledRoute } from '@elizaos/core';
import {
    getPaymentAddress,
    toX402Network,
    toResourceUrl,
    getCAIP19FromConfig,
    getPaymentConfig,
    type Network
} from './payment-config.js';
import {
    createAccepts,
    createX402Response,
    type OutputSchema,
    type X402Response,
    type PaymentExtraMetadata
} from './x402-types.js';
import {
    type X402Request,
    type X402Response as ExpressResponse,
    type X402Runtime,
    type PaymentVerificationParams,
    type EIP712PaymentProof,
    type FacilitatorVerificationResponse,
    type EIP712Authorization,
    type EIP712Domain
} from './types.js';
import { validateX402Startup } from './startup-validator.js';
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
function log(...args: unknown[]) {
    if (DEBUG) console.log(...args);
}
function logSection(title: string) {
    if (DEBUG) {
        console.log('\n' + '═'.repeat(60));
        console.log(`  ${title}`);
        console.log('═'.repeat(60));
    }
}
function logError(...args: unknown[]) {
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
 * Get RPC URL for a network
 */
function getRpcUrl(network: string, runtime: X402Runtime): string {
    const networkUpper = network.toUpperCase();
    const settingKey = `${networkUpper}_RPC_URL`;
    const customRpc = runtime.getSetting(settingKey);
    if (customRpc && typeof customRpc === 'string') {
        return customRpc;
    }

    switch (networkUpper) {
        case 'BASE':
            return 'https://mainnet.base.org';
        case 'POLYGON':
            return 'https://polygon-rpc.com';
        case 'ETHEREUM':
            return 'https://eth.llamarpc.com';
        default:
            return 'https://mainnet.base.org';
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
 * Sanitize and validate payment ID format
 */
function sanitizePaymentId(paymentId: string): string {
    // Remove any whitespace
    const cleaned = paymentId.trim();

    // Validate format (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9_-]+$/.test(cleaned)) {
        throw new Error('Invalid payment ID format');
    }

    // Limit length to prevent abuse
    if (cleaned.length > 128) {
        throw new Error('Payment ID too long');
    }

    return cleaned;
}

/**
 * Verify payment ID via facilitator API
 */
async function verifyPaymentIdViaFacilitator(
    paymentId: string,
    runtime: X402Runtime
): Promise<boolean> {
    logSection('FACILITATOR VERIFICATION');

    // Sanitize payment ID
    let cleanPaymentId: string;
    try {
        cleanPaymentId = sanitizePaymentId(paymentId);
        log('Payment ID:', cleanPaymentId);
    } catch (error) {
        logError('Invalid payment ID:', error instanceof Error ? error.message : String(error));
        return false;
    }

    const facilitatorUrlSetting = runtime.getSetting('X402_FACILITATOR_URL');
    const facilitatorUrl = typeof facilitatorUrlSetting === 'string'
        ? facilitatorUrlSetting
        : 'https://x402.elizaos.ai/api/facilitator';

    if (!facilitatorUrl) {
        logError('⚠️  No facilitator URL configured');
        return false;
    }

    try {
        const cleanUrl = facilitatorUrl.replace(/\/$/, '');
        const endpoint = `${cleanUrl}/verify/${encodeURIComponent(cleanPaymentId)}`;
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
        const responseData: FacilitatorVerificationResponse = responseText ? JSON.parse(responseText) : {};

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
 * Sanitize Solana signature
 */
function sanitizeSolanaSignature(signature: string): string {
    const cleaned = signature.trim();

    // Solana signatures are base58, typically 87-88 characters
    if (!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(cleaned)) {
        throw new Error('Invalid Solana signature format');
    }

    return cleaned;
}

/**
 * Verify a Solana transaction
 */
async function verifySolanaPayment(
    signature: string,
    expectedRecipient: string,
    _expectedAmount: string,
    runtime: X402Runtime
): Promise<boolean> {
    // Sanitize signature
    let cleanSignature: string;
    try {
        cleanSignature = sanitizeSolanaSignature(signature);
        log('Verifying Solana transaction:', cleanSignature.substring(0, 20) + '...');
    } catch (error) {
        logError('Invalid signature:', error instanceof Error ? error.message : String(error));
        return false;
    }

    try {
        const { Connection, PublicKey } = await import('@solana/web3.js');
        const rpcUrlSetting = runtime.getSetting('SOLANA_RPC_URL');
        const rpcUrl = typeof rpcUrlSetting === 'string' ? rpcUrlSetting : 'https://api.mainnet-beta.solana.com';
        const connection = new Connection(rpcUrl);

        const tx = await connection.getTransaction(cleanSignature, {
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
 * Sanitize and parse payment proof data
 */
function sanitizePaymentProof(paymentData: string): string {
    const cleaned = paymentData.trim();

    // Limit size to prevent DoS
    if (cleaned.length > 10000) {
        throw new Error('Payment proof too large');
    }

    return cleaned;
}

/**
 * Verify an EVM transaction or EIP-712 signature
 */
async function verifyEvmPayment(
    paymentData: string,
    expectedRecipient: string,
    expectedAmount: string,
    network: string,
    runtime: X402Runtime,
    req?: X402Request
): Promise<boolean> {
    // Sanitize input
    let cleanPaymentData: string;
    try {
        cleanPaymentData = sanitizePaymentProof(paymentData);
        log(`Verifying ${network} payment:`, cleanPaymentData.substring(0, 20) + '...');
    } catch (error) {
        logError('Invalid payment data:', error instanceof Error ? error.message : String(error));
        return false;
    }

    try {
        if (cleanPaymentData.match(/^0x[a-fA-F0-9]{64}$/)) {
            log('Detected transaction hash format');
            return await verifyEvmTransaction(cleanPaymentData, expectedRecipient, expectedAmount, network, runtime);
        }

        try {
            const parsed: unknown = JSON.parse(cleanPaymentData);
            if (typeof parsed === 'object' && parsed !== null) {
                const proof = parsed as Partial<EIP712PaymentProof>;
                if (proof.signature || (proof.v && proof.r && proof.s)) {
                    log('Detected EIP-712 signature format');
                    return await verifyEip712Authorization(parsed, expectedRecipient, expectedAmount, network, runtime, req);
                }
            }
        } catch (e) {
            // Not JSON, continue
        }

        if (cleanPaymentData.match(/^0x[a-fA-F0-9]{130}$/)) {
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
 * Verify a regular EVM transaction (on-chain)
 */
async function verifyEvmTransaction(
    txHash: string,
    expectedRecipient: string,
    expectedAmount: string,
    network: string,
    runtime: X402Runtime
): Promise<boolean> {
    log('Verifying on-chain transaction:', txHash);

    try {
        const rpcUrl = getRpcUrl(network, runtime);
        const chain = getViemChain(network);

        const { createPublicClient, http, decodeFunctionData, parseAbi } = await import('viem');
        const publicClient = createPublicClient({
            chain,
            transport: http(rpcUrl)
        });

        // Get transaction receipt
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });

        if (receipt.status !== 'success') {
            logError('Transaction failed on-chain');
            return false;
        }

        // Get transaction details
        const tx = await publicClient.getTransaction({ hash: txHash as Hex });

        // expectedAmount is in cents, convert to USDC units (6 decimals)
        // cents * 10^4 = USDC units (e.g., 10 cents * 10000 = 100000 units = $0.10)
        const expectedCents = parseInt(expectedAmount);
        const expectedUnits = BigInt(expectedCents * 10000); // USDC 6 decimals

        // Get USDC contract address for this network
        const usdcContract = getUsdcContractAddress(network);

        // Check if this is an ERC-20 token transfer (transaction to USDC contract)
        if (receipt.to?.toLowerCase() === usdcContract.toLowerCase()) {
            log('Detected ERC-20 token transfer');

            // Decode the ERC-20 transfer function call from tx.input
            if (!tx.input || tx.input === '0x') {
                logError('No input data in transaction');
                return false;
            }

            try {
                // ERC-20 transfer function ABI
                const erc20Abi = parseAbi([
                    'function transfer(address to, uint256 amount) returns (bool)',
                    'function transferFrom(address from, address to, uint256 amount) returns (bool)'
                ]);

                const decoded = decodeFunctionData({
                    abi: erc20Abi,
                    data: tx.input as Hex
                });

                const functionName = decoded.functionName;
                log('Decoded function:', functionName);

                let transferTo: Address;
                let transferAmount: bigint;

                if (functionName === 'transfer') {
                    const [to, amount] = decoded.args as [Address, bigint];
                    transferTo = to;
                    transferAmount = amount;
                } else if (functionName === 'transferFrom') {
                    const [_from, to, amount] = decoded.args as [Address, Address, bigint];
                    transferTo = to;
                    transferAmount = amount;
                } else {
                    logError('Unknown ERC-20 function:', functionName);
                    return false;
                }

                log('Transfer to:', transferTo, 'Amount:', transferAmount.toString());

                // Verify recipient
                if (transferTo.toLowerCase() !== expectedRecipient.toLowerCase()) {
                    logError('ERC-20 transfer recipient mismatch:', transferTo, 'vs', expectedRecipient);
                    return false;
                }

                // Verify amount
                if (transferAmount < expectedUnits) {
                    logError('ERC-20 transfer amount too low:', transferAmount.toString(), 'vs', expectedUnits.toString());
                    return false;
                }

                log('✓ ERC-20 transaction verified');
                return true;

            } catch (decodeError) {
                logError('Failed to decode ERC-20 transfer:', decodeError instanceof Error ? decodeError.message : String(decodeError));
                return false;
            }
        } else if (receipt.to?.toLowerCase() === expectedRecipient.toLowerCase()) {
            // Native ETH transfer
            log('Detected native ETH transfer');

            if (tx.value < expectedUnits) {
                logError('ETH transfer amount too low:', tx.value.toString(), 'vs', expectedUnits.toString());
                return false;
            }

            log('✓ Native ETH transaction verified');
            return true;
        } else {
            logError('Transaction recipient mismatch - expected either USDC contract or recipient address');
            logError('Transaction to:', receipt.to);
            logError('Expected recipient:', expectedRecipient);
            logError('USDC contract:', usdcContract);
            return false;
        }

    } catch (error) {
        logError('Transaction verification error:', error instanceof Error ? error.message : String(error));
        return false;
    }
}

/**
 * Verify EIP-712 authorization signature (ERC-3009 TransferWithAuthorization)
 */
async function verifyEip712Authorization(
    paymentData: unknown,
    expectedRecipient: string,
    expectedAmount: string,
    network: string,
    runtime: X402Runtime,
    req?: X402Request
): Promise<boolean> {
    log('Verifying EIP-712 authorization signature');

    // Type guard for payment data
    if (typeof paymentData !== 'object' || paymentData === null) {
        logError('Invalid payment data: must be an object');
        return false;
    }

    const proofData = paymentData as EIP712PaymentProof;
    log('Payment data:', JSON.stringify(proofData, null, 2));

    try {
        let signature: string;
        let authorization: EIP712Authorization;

        if (proofData.signature && typeof proofData.signature === 'string') {
            signature = proofData.signature;
            authorization = proofData.authorization as EIP712Authorization;
        } else if (proofData.v && proofData.r && proofData.s) {
            signature = `0x${proofData.r}${proofData.s}${proofData.v.toString(16).padStart(2, '0')}`;
            authorization = proofData.authorization as EIP712Authorization;
        } else {
            logError('No valid signature found in payment data');
            return false;
        }

        if (!authorization || typeof authorization !== 'object') {
            logError('No authorization data found in payment data');
            return false;
        }

        // Validate authorization fields
        if (!authorization.from || !authorization.to || !authorization.value || !authorization.nonce) {
            logError('Authorization missing required fields');
            return false;
        }

        log('Authorization:', {
            from: authorization.from?.substring(0, 10) + '...',
            to: authorization.to?.substring(0, 10) + '...',
            value: authorization.value
        });

        // Null check before toLowerCase()
        if (!authorization.to) {
            console.error('Authorization missing "to" field');
            return false;
        }

        if (authorization.to.toLowerCase() !== expectedRecipient.toLowerCase()) {
            console.error('Recipient mismatch:', authorization.to, 'vs', expectedRecipient);
            return false;
        }

        // Verify amount matches
        // expectedAmount is in cents, convert to USDC units (6 decimals)
        // cents * 10^4 = USDC units (e.g., 10 cents * 10000 = 100000 units = $0.10)
        const expectedCents = parseInt(expectedAmount);
        const expectedUnits = expectedCents * 10000; // USDC has 6 decimals
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

        logSection('Cryptographic Signature Verification');

        try {
            let verifyingContract: Address;
            let chainId: number;
            let domainName = 'USD Coin';
            let domainVersion = '2';

            if (proofData.domain && typeof proofData.domain === 'object') {
                const domain = proofData.domain as EIP712Domain;
                log('Using domain from payment data:', domain);
                verifyingContract = domain.verifyingContract as Address;
                chainId = domain.chainId;
                if (domain.name) domainName = domain.name;
                if (domain.version) domainVersion = domain.version;
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
                    const userAgent = req?.headers?.['user-agent'];
                    const isX402Gateway = typeof userAgent === 'string' && userAgent.includes('X402-Gateway');

                    if (isX402Gateway) {
                        log('🔍 Detected X402 Gateway User-Agent');
                        const trustedSignersSetting = runtime.getSetting('X402_TRUSTED_GATEWAY_SIGNERS');
                        const trustedSigners = typeof trustedSignersSetting === 'string'
                            ? trustedSignersSetting
                            : '0x2EB8323f66eE172315503de7325D04c676089267';
                        const signerWhitelist = trustedSigners.split(',').map((addr: string) => addr.trim().toLowerCase());

                        if (signerWhitelist.includes(recoveredAddress.toLowerCase())) {
                            log('✅ Signature verified: signed by authorized X402 Gateway');
                            return true;
                        } else {
                            logError(`✗ Gateway signer NOT in whitelist: ${recoveredAddress}`);
                            logError(`Add to X402_TRUSTED_GATEWAY_SIGNERS to allow: ${recoveredAddress}`);
                            return false;
                        }
                    } else {
                        logError('✗ Signature verification failed: signer mismatch');
                        logError(`Expected: ${authorization.from}, Actual: ${recoveredAddress}`);
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

    // TypeScript allows more specific parameter types when assigning to Route['handler']
    // We use our strict types directly instead of 'any' for better type safety
    return async (req: X402Request, res: ExpressResponse, runtime: X402Runtime) => {
        const typedReq = req;
        const typedRes = res;
        const typedRuntime = runtime;
        if (!route.x402) {
            if (originalHandler) {
                return originalHandler(req, res, runtime);
            }
            return;
        }

        logSection(`X402 Payment Check - ${route.path}`);
        log('Method:', typedReq.method);

        if (route.validator) {
            try {
                const validationResult = await route.validator(typedReq);

                if (!validationResult.valid) {
                    logError('✗ Validation failed:', validationResult.error?.message);

                    const x402Response = buildX402Response(route, typedRuntime);

                    const errorMessage = validationResult.error?.details
                        ? `${validationResult.error.message}: ${JSON.stringify(validationResult.error.details)}`
                        : validationResult.error?.message || 'Invalid request parameters';

                    return typedRes.status(402).json({
                        ...x402Response,
                        error: errorMessage
                    });
                }

                log('✓ Validation passed');
            } catch (error) {
                logError('✗ Validation error:', error instanceof Error ? error.message : String(error));

                const x402Response = buildX402Response(route, typedRuntime);
                return typedRes.status(402).json({
                    ...x402Response,
                    error: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
                });
            }
        }

        log('Headers:', JSON.stringify(typedReq.headers, null, 2));
        log('Query:', JSON.stringify(typedReq.query, null, 2));
        if (typedReq.method === 'POST' && typedReq.body) {
            log('Body:', JSON.stringify(typedReq.body, null, 2));
        }

        const paymentProof = typedReq.headers['x-payment-proof'] || typedReq.headers['x-payment'] || typedReq.query.paymentProof;
        const paymentId = typedReq.headers['x-payment-id'] || typedReq.query.paymentId;

        log('Payment credentials:', {
            'x-payment-proof': !!typedReq.headers['x-payment-proof'],
            'x-payment': !!typedReq.headers['x-payment'],
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
                    paymentProof: typeof paymentProof === 'string' ? paymentProof : undefined,
                    paymentId: typeof paymentId === 'string' ? paymentId : undefined,
                    route: route.path,
                    expectedAmount,
                    runtime: typedRuntime,
                    req: typedReq
                });

                if (isValid) {
                    log('✓ PAYMENT VERIFIED - executing handler');
                    if (originalHandler) {
                        return originalHandler(req, res, runtime);
                    }
                    return;
                } else {
                    logError('✗ PAYMENT VERIFICATION FAILED');
                    typedRes.status(402).json({
                        error: 'Payment verification failed',
                        message: 'The provided payment proof is invalid or has expired',
                        x402Version: 1
                    });
                    return;
                }
            } catch (error) {
                logError('✗ PAYMENT VERIFICATION ERROR:', error instanceof Error ? error.message : String(error));
                typedRes.status(402).json({
                    error: 'Payment verification error',
                    message: error instanceof Error ? error.message : String(error),
                    x402Version: 1
                });
                return;
            }
        }

        log('No payment credentials - returning 402');

        try {
            const x402Response = buildX402Response(route, typedRuntime);
            log('Payment options:', {
                paymentConfigs: route.x402.paymentConfigs || ['base_usdc'],
                priceInCents: route.x402.priceInCents,
                count: x402Response.accepts?.length || 0
            });
            log('402 Response:', JSON.stringify(x402Response, null, 2));

            typedRes.status(402).json(x402Response);
        } catch (error) {
            logError('✗ Failed to build x402 response:', error instanceof Error ? error.message : String(error));
            typedRes.status(402).json(createX402Response({
                error: `Payment Required: ${error instanceof Error ? error.message : 'Unknown error'}`
            }));
        }
    };
}

/**
 * Build x402scan-compliant response for a route
 */
function buildX402Response(route: PaymentEnabledRoute, runtime?: X402Runtime): X402Response {
    if (!route.x402?.priceInCents) {
        throw new Error('Route x402.priceInCents is required for x402 response');
    }

    const paymentConfigs = route.x402?.paymentConfigs || ['base_usdc'];
    const agentId = runtime?.agentId ? String(runtime.agentId) : undefined;

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

        const extra: PaymentExtraMetadata = {
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
 * OpenAPI schema types for type safety
 */
interface OpenAPIPropertySchema {
    type?: string;
    description?: string;
    enum?: string[];
    pattern?: string;
    properties?: Record<string, OpenAPIPropertySchema>;
}

interface OpenAPIObjectSchema extends OpenAPIPropertySchema {
    type: 'object';
    required?: string[];
}

/**
 * Field definition for schema conversion
 */
interface FieldDefinition {
    type?: string;
    required?: boolean;
    description?: string;
    enum?: string[];
    pattern?: string;
    properties?: Record<string, FieldDefinition>;
}

/**
 * Convert OpenAPI schema to FieldDef format
 */
function convertOpenAPISchemaToFieldDef(schema: OpenAPIObjectSchema | OpenAPIPropertySchema): Record<string, FieldDefinition> {
    if ('properties' in schema && schema.properties) {
        const fields: Record<string, FieldDefinition> = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            fields[key] = {
                type: value.type,
                required: ('required' in schema && schema.required) ? schema.required.includes(key) : false,
                description: value.description,
                enum: value.enum,
                pattern: value.pattern,
                properties: value.properties ? convertOpenAPISchemaToFieldDef(value) : undefined
            };
        }
        return fields;
    }
    return {};
}

/**
 * Input schema structure
 */
interface InputSchema {
    pathParams?: Record<string, FieldDefinition>;
    queryParams?: Record<string, FieldDefinition>;
    bodyFields?: Record<string, FieldDefinition>;
}

/**
 * Build input schema from route
 */
function buildInputSchemaFromRoute(route: PaymentEnabledRoute): InputSchema {
    const schema: InputSchema = {};

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

// Re-export types from core
export type { X402ValidationResult, X402RequestValidator } from '@elizaos/core';

/**
 * Apply payment protection to an array of routes
 * Runs comprehensive startup validation before applying protection
 */
export function applyPaymentProtection(routes: Route[]): Route[] {
    if (!Array.isArray(routes)) {
        throw new Error('routes must be an array');
    }

    // Run comprehensive startup validation
    const validation = validateX402Startup(routes);

    // Throw if validation failed
    if (!validation.valid) {
        throw new Error(
            `\nx402 Configuration Invalid (${validation.errors.length} error${validation.errors.length > 1 ? 's' : ''}):\n\n` +
            validation.errors.map(e => `  • ${e}`).join('\n') +
            '\n\nPlease fix these errors and try again.\n'
        );
    }

    // Apply payment protection to routes with x402 config
    return routes.map(route => {
        const x402Route = route as PaymentEnabledRoute;
        if (x402Route.x402) {
            console.log('✓ Payment protection enabled:', x402Route.path, {
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

