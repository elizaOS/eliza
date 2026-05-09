import type {
  Character,
  IAgentRuntime,
  PaymentEnabledRoute,
  Route,
  RouteRequest,
  RouteResponse,
  X402Config,
} from "@elizaos/core";
import { logger } from "@elizaos/core";

/** Route with resolved `x402` object (not `true`) */
type X402PaidRoute = PaymentEnabledRoute & { x402: X402Config };

import {
  type Address,
  type Hex,
  recoverTypedDataAddress,
  type TypedDataDomain,
} from "viem";
import { base, bsc, mainnet, polygon } from "viem/chains";
import {
  atomicAmountForPriceInCents,
  getCAIP19FromConfig,
  getPaymentConfig,
  type Network,
  toResourceUrl,
  toX402Network,
} from "./payment-config.js";
import { validateX402Startup } from "./startup-validator.js";
import type {
  EIP712Authorization,
  EIP712Domain,
  EIP712PaymentProof,
  X402Response as ExpressResponse,
  FacilitatorVerificationResponse,
  FacilitatorVerifyContext,
  PaymentVerificationParams,
  PaymentVerifiedDetails,
  VerifyPaymentResult,
  X402Request,
  X402Runtime,
} from "./types.js";
import {
  facilitatorVerifyResponseMatchesRoute,
  isFacilitatorBindingRelaxed,
} from "./x402-facilitator-binding.js";
import {
  replayGuardAbortAsync,
  replayGuardCommit,
  replayGuardTryBegin,
} from "./x402-replay-guard.js";
import {
  collectReplayKeysToCheck,
  decodePaymentProofForParsing,
} from "./x402-replay-keys.js";
import {
  resolveEffectiveX402,
  X402_EVENT_PAYMENT_REQUIRED,
  X402_EVENT_PAYMENT_VERIFIED,
} from "./x402-resolve.js";
import {
  buildFacilitatorPaymentRequirements,
  buildStandardPaymentRequired,
  decodeXPaymentHeader,
  findMatchingPaymentConfigForStandardPayload,
  isX402StandardPaymentPayload,
  settlePaymentPayloadViaFacilitatorPost,
  verifyPaymentPayloadViaFacilitatorPost,
} from "./x402-standard-payment.js";
import {
  createAccepts,
  createX402Response,
  type OutputSchema,
  type PaymentExtraMetadata,
  type X402Response,
} from "./x402-types.js";

/**
 * x402 **seller** middleware for plugin HTTP routes.
 *
 * **Why one middleware layer:** plugins should not each reimplement 402 bodies,
 * header encodings, facilitator POSTs, replay semantics, or chain RPC checks.
 * This module is the single integration point for “paid route” behavior.
 *
 * **Why multiple verification strategies coexist:** deployments differ—some
 * have on-chain receipts only, some use facilitator payment IDs, some use modern
 * `PAYMENT-SIGNATURE` payloads. Keeping strategies behind one `verifyPayment`
 * function preserves one gate while letting operators choose what their clients send.
 *
 * **Why standard path calls settle:** see `x402-standard-payment.ts`—settlement is
 * the economically meaningful step after verify for facilitator-backed flows.
 *
 * **Why we still emit legacy JSON 402:** backward compatibility for wallets and
 * tools that parse the body; V2 clients additionally read `PAYMENT-REQUIRED`.
 */

/**
 * Set on routes returned by {@link applyPaymentProtection} so HTTP dispatch
 * (`tryHandleRuntimePluginRoute`) does not call {@link createPaymentAwareHandler} again.
 */
export const X402_ROUTE_PAYMENT_WRAPPED = Symbol.for(
  "elizaos.x402.routePaymentWrapped",
);

export function isRoutePaymentWrapped(route: unknown): boolean {
  return (
    typeof route === "object" &&
    route !== null &&
    Reflect.get(route, X402_ROUTE_PAYMENT_WRAPPED) === true
  );
}

/**
 * Debug logging helper - only logs if DEBUG_X402_PAYMENTS is enabled
 */
const DEBUG = process.env.DEBUG_X402_PAYMENTS === "true";
function formatLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (typeof arg === "bigint") return arg.toString();
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
function log(...args: unknown[]) {
  if (DEBUG) logger.debug(args.map(formatLogArg).join(" "));
}
function logSection(title: string) {
  if (DEBUG) {
    logger.debug(`[x402] ${title}`);
  }
}
function logError(...args: unknown[]) {
  logger.error(args.map(formatLogArg).join(" "));
}

/**
 * EIP-712 TransferWithAuthorization type
 */
const TRANSFER_WITH_AUTHORIZATION_TYPES = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

/**
 * EIP-712 ReceiveWithAuthorization type
 */
const RECEIVE_WITH_AUTHORIZATION_TYPES = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

/**
 * Get the viem chain object for a network
 */
function getViemChain(network: string) {
  switch (network.toUpperCase()) {
    case "BASE":
      return base;
    case "POLYGON":
      return polygon;
    case "BSC":
      return bsc;
    case "ETHEREUM":
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
  if (customRpc && typeof customRpc === "string") {
    return customRpc;
  }

  switch (networkUpper) {
    case "BASE":
      return "https://mainnet.base.org";
    case "POLYGON":
      return "https://polygon-rpc.com";
    case "BSC":
      return "https://bsc-dataseed.binance.org";
    case "ETHEREUM":
      return "https://eth.llamarpc.com";
    default:
      return "https://mainnet.base.org";
  }
}

/**
 * Get USDC contract address for a network
 */
function getUsdcContractAddress(network: string): Address {
  switch (network.toUpperCase()) {
    case "BASE":
      return "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    case "POLYGON":
      return "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
    case "BSC":
      return "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
    case "ETHEREUM":
      return "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    default:
      return "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  }
}

function chainIdToNetwork(chainId: number): Network | null {
  if (chainId === 8453) return "BASE";
  if (chainId === 137) return "POLYGON";
  if (chainId === 56) return "BSC";
  return null;
}

function sumOwnerMint(
  balances:
    | Array<{ mint: string; owner?: string; uiTokenAmount: { amount: string } }>
    | null
    | undefined,
  owner: string,
  mint: string,
): bigint {
  if (!balances?.length) return 0n;
  let s = 0n;
  for (const b of balances) {
    if (b.mint === mint && b.owner === owner) {
      s += BigInt(b.uiTokenAmount?.amount ?? "0");
    }
  }
  return s;
}

/**
 * Verify payment proof from x402 payment provider
 */
async function verifyPayment(
  params: PaymentVerificationParams,
): Promise<VerifyPaymentResult> {
  const {
    paymentProof,
    paymentId,
    route,
    priceInCents,
    paymentConfigNames,
    agentId,
    runtime,
    req,
  } = params;

  logSection("PAYMENT VERIFICATION");
  log(
    "Route:",
    route,
    "priceInCents:",
    priceInCents,
    "configs:",
    paymentConfigNames,
  );

  if (!paymentProof && !paymentId) {
    logError("✗ No payment credentials provided");
    return { ok: false };
  }

  const replayKeys = collectReplayKeysToCheck(paymentProof, paymentId);
  if (!(await replayGuardTryBegin(replayKeys, runtime, agentId))) {
    logError(
      "✗ Payment credential in use or already consumed (replay protection)",
    );
    return { ok: false };
  }

  let committed = false;
  const finishVerified = async (
    details: PaymentVerifiedDetails,
  ): Promise<VerifyPaymentResult> => {
    committed = true;
    await replayGuardCommit(replayKeys, runtime, agentId);
    return { ok: true, details };
  };

  try {
    const configsOrdered = paymentConfigNames.map((n) => ({
      name: n,
      cfg: getPaymentConfig(n, agentId),
    }));

    if (paymentProof) {
      try {
        // Standard payloads (PAYMENT-SIGNATURE / X-Payment) are tried first so we
        // do not mis-classify them as legacy JSON proofs or raw tx hashes. Why:
        // the same header value can look like opaque base64; decode + shape
        // detection routes buyers to facilitator verify+settle instead of unsafe
        // local EIP-712 paths.
        const standardDecoded = decodeXPaymentHeader(
          typeof paymentProof === "string" ? paymentProof : "",
        );
        if (isX402StandardPaymentPayload(standardDecoded)) {
          const match = findMatchingPaymentConfigForStandardPayload(
            standardDecoded,
            paymentConfigNames,
            priceInCents,
            agentId,
          );
          if (!match) {
            // Standard x402 payload had no matching config (wrong network /
            // asset / amount). Reject outright instead of re-evaluating the
            // same payload through legacy JSON / EIP-712 paths with looser
            // routing rules.
            log(
              "Standard X-Payment payload did not match any allowed payment config",
            );
            return { ok: false };
          }

          const paymentRequirements = buildFacilitatorPaymentRequirements({
            routePath: route,
            priceInCents,
            configName: match.name,
            agentId,
          });
          const postResult = await verifyPaymentPayloadViaFacilitatorPost(
            runtime,
            standardDecoded,
            paymentRequirements,
          );
          if (postResult.ok !== true) {
            log(
              "Standard X-Payment facilitator verify failed:",
              postResult.invalidReason,
            );
            // Do not fall through to legacy JSON / local EIP-712 paths with the
            // same header — the facilitator has already rejected this credential.
            return { ok: false };
          }
          const settleResult = await settlePaymentPayloadViaFacilitatorPost(
            runtime,
            standardDecoded,
            paymentRequirements,
          );
          if (settleResult.ok === false) {
            log(
              "Standard X-Payment facilitator settle failed:",
              settleResult.invalidReason,
            );
            return { ok: false };
          }
          log(
            "✓ Standard X-Payment verified and settled via facilitator",
            match.name,
          );
          return await finishVerified({
            paymentConfig: match.name,
            network: match.cfg.network,
            amountAtomic: paymentRequirements.amount,
            symbol: match.cfg.symbol,
            payer:
              settleResult.payer ??
              postResult.payer ??
              standardDecoded.payload.authorization.from,
            proofId: standardDecoded.payload.signature,
            paymentResponse: settleResult.paymentResponse,
          });
        }

        const decodedProof = decodePaymentProofForParsing(paymentProof);

        try {
          const jsonProof = JSON.parse(decodedProof) as {
            payload?: {
              signature?: string;
              authorization?: EIP712Authorization;
              domain?: EIP712Domain;
            };
            domain?: EIP712Domain;
            network?: string;
            scheme?: string;
          };
          log("Detected JSON payment proof");

          const authData = jsonProof.payload
            ? {
                signature: jsonProof.payload.signature,
                authorization: jsonProof.payload.authorization,
                network: jsonProof.network,
                scheme: jsonProof.scheme,
                domain: jsonProof.payload.domain ?? jsonProof.domain,
              }
            : { ...jsonProof, domain: jsonProof.domain };

          const domain =
            (authData as { domain?: EIP712Domain }).domain ?? jsonProof.domain;
          const chainId = domain?.chainId;
          const inferredNet =
            typeof chainId === "number" ? chainIdToNetwork(chainId) : null;

          const authObj = authData as Record<string, unknown>;
          const hasEip712 =
            typeof authObj.signature === "string" &&
            authObj.authorization &&
            typeof authObj.authorization === "object";

          if (hasEip712) {
            const evmCandidates = configsOrdered.filter(
              (c) =>
                c.cfg.network === "BASE" ||
                c.cfg.network === "POLYGON" ||
                c.cfg.network === "BSC",
            );

            for (const { name, cfg } of evmCandidates) {
              if (inferredNet && cfg.network !== inferredNet) continue;
              if (
                domain?.verifyingContract &&
                domain.verifyingContract.toLowerCase() !==
                  cfg.assetReference.toLowerCase()
              ) {
                continue;
              }

              const atomic = atomicAmountForPriceInCents(priceInCents, cfg);
              const recipient = cfg.paymentAddress;
              const ok = await verifyEvmPayment(
                JSON.stringify(authData),
                recipient,
                atomic,
                cfg.network,
                runtime,
                req,
                {
                  eip712TokenContract: cfg.assetReference as Address,
                  erc20Contract: cfg.assetReference as Address,
                },
              );
              if (ok) {
                const auth = authObj.authorization as EIP712Authorization;
                log(
                  `✓ ${cfg.network} payment verified (EIP-712) config=${name}`,
                );
                return await finishVerified({
                  paymentConfig: name,
                  network: cfg.network,
                  amountAtomic: atomic,
                  symbol: cfg.symbol,
                  payer: auth?.from,
                  proofId:
                    typeof authObj.signature === "string"
                      ? authObj.signature
                      : undefined,
                });
              }
            }
          }
        } catch {
          const parts = decodedProof.split(":");

          if (parts.length >= 3) {
            const [networkRaw, address, signature] = parts;
            const network = networkRaw.toUpperCase();
            log(`Legacy format: ${network}`);

            if (network === "SOLANA") {
              for (const { name, cfg } of configsOrdered) {
                if (cfg.network !== "SOLANA") continue;
                if (address.trim() !== cfg.paymentAddress.trim()) {
                  logError(
                    "Solana legacy proof: recipient field must equal the route pay-to address (expected",
                    cfg.paymentAddress,
                    "got",
                    address,
                  );
                  continue;
                }
                const atomic = atomicAmountForPriceInCents(priceInCents, cfg);
                if (
                  await verifySolanaPayment(
                    signature,
                    cfg.paymentAddress,
                    cfg.assetReference,
                    atomic,
                    runtime,
                  )
                ) {
                  log("✓ Solana payment verified");
                  return await finishVerified({
                    paymentConfig: name,
                    network: "SOLANA",
                    amountAtomic: atomic,
                    symbol: cfg.symbol,
                    proofId: signature,
                  });
                }
              }
            } else if (
              network === "BASE" ||
              network === "POLYGON" ||
              network === "BSC"
            ) {
              for (const { name, cfg } of configsOrdered) {
                if (cfg.network !== network) continue;
                if (cfg.assetNamespace !== "erc20") continue;
                const atomic = atomicAmountForPriceInCents(priceInCents, cfg);
                if (
                  await verifyEvmPayment(
                    signature,
                    cfg.paymentAddress,
                    atomic,
                    network,
                    runtime,
                    req,
                    {
                      erc20Contract: cfg.assetReference as Address,
                      eip712TokenContract: cfg.assetReference as Address,
                    },
                  )
                ) {
                  log(`✓ ${network} payment verified`);
                  return await finishVerified({
                    paymentConfig: name,
                    network: cfg.network,
                    amountAtomic: atomic,
                    symbol: cfg.symbol,
                    proofId: signature,
                  });
                }
              }
            }
          } else if (parts.length === 1 && parts[0].length > 50) {
            const sigOnly = parts[0];
            for (const { name, cfg } of configsOrdered) {
              if (cfg.network !== "SOLANA") continue;
              const atomic = atomicAmountForPriceInCents(priceInCents, cfg);
              if (
                await verifySolanaPayment(
                  sigOnly,
                  cfg.paymentAddress,
                  cfg.assetReference,
                  atomic,
                  runtime,
                )
              ) {
                log("✓ Solana payment verified (raw signature)");
                return await finishVerified({
                  paymentConfig: name,
                  network: "SOLANA",
                  amountAtomic: atomic,
                  symbol: cfg.symbol,
                  proofId: sigOnly,
                });
              }
            }
          }
        }
      } catch (error) {
        logError(
          "Blockchain verification error:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (paymentId) {
      try {
        if (
          await verifyPaymentIdViaFacilitator(paymentId, runtime, {
            resource: toResourceUrl(route),
            routePath: route,
            priceInCents,
            paymentConfigNames,
          })
        ) {
          log("✓ Facilitator payment verified");
          return await finishVerified({
            paymentConfig: "facilitator",
            network: "facilitator",
            amountAtomic: "",
            proofId: paymentId,
          });
        }
      } catch (error) {
        logError(
          "Facilitator verification error:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    logError("✗ All payment verification strategies failed");
    return { ok: false };
  } finally {
    if (!committed) await replayGuardAbortAsync(replayKeys, runtime, agentId);
  }
}

/**
 * Sanitize and validate payment ID format
 */
function sanitizePaymentId(paymentId: string): string {
  // Remove any whitespace
  const cleaned = paymentId.trim();

  // Validate format (alphanumeric, hyphens, underscores only)
  if (!/^[a-zA-Z0-9_-]+$/.test(cleaned)) {
    throw new Error("Invalid payment ID format");
  }

  // Limit length to prevent abuse
  if (cleaned.length > 128) {
    throw new Error("Payment ID too long");
  }

  return cleaned;
}

/**
 * Verify payment ID via facilitator API
 */
async function verifyPaymentIdViaFacilitator(
  paymentId: string,
  runtime: X402Runtime,
  ctx?: FacilitatorVerifyContext,
): Promise<boolean> {
  logSection("FACILITATOR VERIFICATION");

  // Sanitize payment ID
  let cleanPaymentId: string;
  try {
    cleanPaymentId = sanitizePaymentId(paymentId);
    log("Payment ID:", cleanPaymentId);
  } catch (error) {
    logError(
      "Invalid payment ID:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }

  const facilitatorUrlSetting = runtime.getSetting("X402_FACILITATOR_URL");
  const facilitatorUrl =
    typeof facilitatorUrlSetting === "string"
      ? facilitatorUrlSetting
      : "https://x402.elizaos.ai/api/facilitator";

  if (!facilitatorUrl) {
    logError("⚠️  No facilitator URL configured");
    return false;
  }

  try {
    const cleanUrl = facilitatorUrl.replace(/\/$/, "");
    const verifyPath = `${cleanUrl}/verify/${encodeURIComponent(cleanPaymentId)}`;
    const url = new URL(verifyPath);
    if (ctx) {
      url.searchParams.set("resource", ctx.resource);
      url.searchParams.set("routePath", ctx.routePath);
      url.searchParams.set("priceInCents", String(ctx.priceInCents));
      url.searchParams.set("paymentConfigs", ctx.paymentConfigNames.join(","));
    }
    const endpoint = url.toString();
    log("Verifying at:", endpoint);

    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "ElizaOS-X402-Client/1.0",
      },
      signal: AbortSignal.timeout(10000),
    });

    const responseText = await response.text();
    const responseData: FacilitatorVerificationResponse = responseText
      ? JSON.parse(responseText)
      : {};

    if (response.ok) {
      const isValid =
        responseData?.valid !== false && responseData?.verified !== false;
      if (isValid) {
        if (
          ctx &&
          !facilitatorVerifyResponseMatchesRoute(
            responseData,
            ctx,
            isFacilitatorBindingRelaxed(),
          )
        ) {
          logError(
            isFacilitatorBindingRelaxed()
              ? "✗ Facilitator response failed route binding checks"
              : "✗ Facilitator strict binding failed (response must include matching resource, routePath or route, priceInCents, paymentConfig). Set X402_FACILITATOR_RELAXED_BINDING=1 if your facilitator cannot echo these fields yet.",
          );
          return false;
        }
        log("✓ Facilitator verified payment");
        return true;
      } else {
        logError("✗ Payment invalid per facilitator");
        return false;
      }
    } else if (response.status === 404) {
      logError("✗ Payment ID not found (404)");
      return false;
    } else if (response.status === 410) {
      logError("✗ Payment ID already used (410 - replay attack prevented)");
      return false;
    } else {
      logError(
        `✗ Facilitator error: ${response.status} ${response.statusText}`,
      );
      return false;
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logError("✗ Facilitator request timed out (10s)");
    } else {
      logError(
        "✗ Facilitator verification error:",
        error instanceof Error ? error.message : String(error),
      );
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
    throw new Error("Invalid Solana signature format");
  }

  return cleaned;
}

/**
 * Verify a Solana SPL transfer landed on-chain for the expected mint, recipient, and amount.
 */
async function verifySolanaPayment(
  signature: string,
  expectedRecipient: string,
  expectedMint: string,
  expectedAmountAtomic: string,
  runtime: X402Runtime,
): Promise<boolean> {
  let cleanSignature: string;
  try {
    cleanSignature = sanitizeSolanaSignature(signature);
    log(
      "Verifying Solana transaction:",
      `${cleanSignature.substring(0, 20)}...`,
    );
  } catch (error) {
    logError(
      "Invalid signature:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }

  try {
    const { Connection } = await import("@solana/web3.js");
    const rpcUrlSetting = runtime.getSetting("SOLANA_RPC_URL");
    const rpcUrl =
      typeof rpcUrlSetting === "string"
        ? rpcUrlSetting
        : "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpcUrl);

    const tx = await connection.getTransaction(cleanSignature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      logError("Transaction not found on Solana blockchain");
      return false;
    }

    if (tx.meta?.err) {
      logError("Transaction failed on-chain:", tx.meta.err);
      return false;
    }

    const meta = tx.meta;
    const pre = sumOwnerMint(
      meta?.preTokenBalances as Parameters<typeof sumOwnerMint>[0],
      expectedRecipient,
      expectedMint,
    );
    const post = sumOwnerMint(
      meta?.postTokenBalances as Parameters<typeof sumOwnerMint>[0],
      expectedRecipient,
      expectedMint,
    );
    const delta = post - pre;
    const need = BigInt(expectedAmountAtomic);
    if (delta < need) {
      logError(
        "Solana SPL credit too low:",
        delta.toString(),
        "vs required",
        need.toString(),
      );
      return false;
    }

    log("✓ Solana SPL transfer verified");
    return true;
  } catch (error) {
    logError(
      "Solana verification error:",
      error instanceof Error ? error.message : String(error),
    );
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
    throw new Error("Payment proof too large");
  }

  return cleaned;
}

type EvmPaymentVerifyOpts = {
  /** On-chain tx: `receipt.to` must be this ERC-20 contract */
  erc20Contract?: Address;
  /** EIP-712: domain `verifyingContract` must match this token */
  eip712TokenContract?: Address;
};

/**
 * Verify an EVM transaction or EIP-712 signature
 */
async function verifyEvmPayment(
  paymentData: string,
  expectedRecipient: string,
  expectedAmountAtomic: string,
  network: string,
  runtime: X402Runtime,
  req?: X402Request,
  opts?: EvmPaymentVerifyOpts,
): Promise<boolean> {
  let cleanPaymentData: string;
  try {
    cleanPaymentData = sanitizePaymentProof(paymentData);
    log(
      `Verifying ${network} payment:`,
      `${cleanPaymentData.substring(0, 20)}...`,
    );
  } catch (error) {
    logError(
      "Invalid payment data:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }

  try {
    if (cleanPaymentData.match(/^0x[a-fA-F0-9]{64}$/)) {
      log("Detected transaction hash format");
      return await verifyEvmTransaction(
        cleanPaymentData,
        expectedRecipient,
        expectedAmountAtomic,
        network,
        runtime,
        opts?.erc20Contract,
      );
    }

    try {
      const parsed: unknown = JSON.parse(cleanPaymentData);
      if (typeof parsed === "object" && parsed !== null) {
        const proof = parsed as Partial<EIP712PaymentProof>;
        if (proof.signature || (proof.v && proof.r && proof.s)) {
          log("Detected EIP-712 signature format");
          const allowEip712 =
            process.env.X402_ALLOW_EIP712_SIGNATURE_VERIFICATION === "true" ||
            process.env.X402_ALLOW_EIP712_SIGNATURE_VERIFICATION === "1";
          if (!allowEip712) {
            logError(
              "EIP-712 authorization proofs are disabled (they do not prove on-chain settlement). Set X402_ALLOW_EIP712_SIGNATURE_VERIFICATION=1 only if you accept that risk.",
            );
            return false;
          }
          const token = opts?.eip712TokenContract;
          if (!token) {
            logError("EIP-712 verification missing expected token contract");
            return false;
          }
          return await verifyEip712Authorization(
            parsed,
            expectedRecipient,
            expectedAmountAtomic,
            token,
            network,
            runtime,
            req,
          );
        }
      }
    } catch {
      // Not JSON, continue
    }

    if (cleanPaymentData.match(/^0x[a-fA-F0-9]{130}$/)) {
      logError("Raw signature detected but authorization parameters missing");
      return false;
    }

    logError("Unrecognized EVM payment format");
    return false;
  } catch (error) {
    logError(
      "EVM verification error:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * Verify a regular EVM transaction (on-chain ERC-20 transfer / transferFrom).
 * `expectedAmountAtomic` is the minimum token amount in smallest units (string integer).
 */
async function verifyEvmTransaction(
  txHash: string,
  expectedRecipient: string,
  expectedAmountAtomic: string,
  network: string,
  runtime: X402Runtime,
  tokenContract?: Address,
): Promise<boolean> {
  log("Verifying on-chain transaction:", txHash);

  try {
    const rpcUrl = getRpcUrl(network, runtime);
    const chain = getViemChain(network);

    const { createPublicClient, http, decodeFunctionData, parseAbi } =
      await import("viem");
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    const receipt = await publicClient.getTransactionReceipt({
      hash: txHash as Hex,
    });

    if (receipt.status !== "success") {
      logError("Transaction failed on-chain");
      return false;
    }

    const tx = await publicClient.getTransaction({ hash: txHash as Hex });

    const targetContract = tokenContract ?? getUsdcContractAddress(network);
    const expectedUnits = BigInt(expectedAmountAtomic);

    if (receipt.to?.toLowerCase() !== targetContract.toLowerCase()) {
      logError("Transaction not to expected token contract:", receipt.to);
      return false;
    }

    log("Detected ERC-20 token transfer");

    if (tx.input === "0x") {
      logError("No input data in transaction");
      return false;
    }

    try {
      const erc20Abi = parseAbi([
        "function transfer(address to, uint256 amount) returns (bool)",
        "function transferFrom(address from, address to, uint256 amount) returns (bool)",
      ]);

      const decoded = decodeFunctionData({
        abi: erc20Abi,
        data: tx.input as Hex,
      });

      const functionName = decoded.functionName;
      log("Decoded function:", functionName);

      let transferTo: Address;
      let transferAmount: bigint;

      if (functionName === "transfer") {
        const [to, amount] = decoded.args as [Address, bigint];
        transferTo = to;
        transferAmount = amount;
      } else if (functionName === "transferFrom") {
        const [_from, to, amount] = decoded.args as [Address, Address, bigint];
        transferTo = to;
        transferAmount = amount;
      } else {
        logError("Unknown ERC-20 function:", functionName);
        return false;
      }

      log("Transfer to:", transferTo, "Amount:", transferAmount.toString());

      if (transferTo.toLowerCase() !== expectedRecipient.toLowerCase()) {
        logError(
          "ERC-20 transfer recipient mismatch:",
          transferTo,
          "vs",
          expectedRecipient,
        );
        return false;
      }

      if (transferAmount < expectedUnits) {
        logError(
          "ERC-20 transfer amount too low:",
          transferAmount.toString(),
          "vs",
          expectedUnits.toString(),
        );
        return false;
      }

      log("✓ ERC-20 transaction verified");
      return true;
    } catch (decodeError) {
      logError(
        "Failed to decode ERC-20 transfer:",
        decodeError instanceof Error
          ? decodeError.message
          : String(decodeError),
      );
      return false;
    }
  } catch (error) {
    logError(
      "Transaction verification error:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * Verify EIP-712 authorization signature (ERC-3009 TransferWithAuthorization)
 */
async function verifyEip712Authorization(
  paymentData: unknown,
  expectedRecipient: string,
  expectedAmountAtomic: string,
  expectedVerifyingContract: Address,
  network: string,
  runtime: X402Runtime,
  req?: X402Request,
): Promise<boolean> {
  log("Verifying EIP-712 authorization signature");

  // Type guard for payment data
  if (typeof paymentData !== "object" || paymentData === null) {
    logError("Invalid payment data: must be an object");
    return false;
  }

  const proofData = paymentData as EIP712PaymentProof;
  log("Payment data:", JSON.stringify(proofData, null, 2));

  try {
    let signature: string;
    let authorization: EIP712Authorization;

    if (proofData.signature && typeof proofData.signature === "string") {
      signature = proofData.signature;
      authorization = proofData.authorization as EIP712Authorization;
    } else if (proofData.v && proofData.r && proofData.s) {
      signature = `0x${proofData.r}${proofData.s}${proofData.v.toString(16).padStart(2, "0")}`;
      authorization = proofData.authorization as EIP712Authorization;
    } else {
      logError("No valid signature found in payment data");
      return false;
    }

    if (!authorization || typeof authorization !== "object") {
      logError("No authorization data found in payment data");
      return false;
    }

    // Validate authorization fields
    if (
      !authorization.from ||
      !authorization.to ||
      !authorization.value ||
      !authorization.nonce
    ) {
      logError("Authorization missing required fields");
      return false;
    }

    log("Authorization:", {
      from: `${authorization.from?.substring(0, 10)}...`,
      to: `${authorization.to?.substring(0, 10)}...`,
      value: authorization.value,
    });

    // Null check before toLowerCase()
    if (!authorization.to) {
      logError('Authorization missing "to" field');
      return false;
    }

    if (authorization.to.toLowerCase() !== expectedRecipient.toLowerCase()) {
      logError(
        "Recipient mismatch:",
        authorization.to,
        "vs",
        expectedRecipient,
      );
      return false;
    }

    const need = BigInt(expectedAmountAtomic);
    const authValue = BigInt(authorization.value);
    if (authValue < need) {
      logError("Amount too low:", authValue.toString(), "vs", need.toString());
      return false;
    }

    const now = Math.floor(Date.now() / 1000);
    const validAfter = Number.parseInt(authorization.validAfter || "0", 10);
    const validBefore = Number.parseInt(
      authorization.validBefore || String(now + 86400),
      10,
    );

    if (now < validAfter) {
      logError("Authorization not yet valid:", now, "<", validAfter);
      return false;
    }

    if (now > validBefore) {
      logError("Authorization expired:", now, ">", validBefore);
      return false;
    }

    log("✓ EIP-712 authorization parameters valid");

    logSection("Cryptographic Signature Verification");

    try {
      let verifyingContract: Address;
      let chainId: number;
      let domainName = "USD Coin";
      let domainVersion = "2";

      const expectedChainId = getViemChain(network).id;

      if (proofData.domain && typeof proofData.domain === "object") {
        const domain = proofData.domain as EIP712Domain;
        log("Using domain from payment data:", domain);
        if (
          (domain.verifyingContract as string).toLowerCase() !==
          expectedVerifyingContract.toLowerCase()
        ) {
          logError(
            "EIP-712 verifyingContract does not match route token:",
            domain.verifyingContract,
            expectedVerifyingContract,
          );
          return false;
        }
        if (domain.chainId !== expectedChainId) {
          logError(
            "EIP-712 chainId mismatch:",
            domain.chainId,
            "expected",
            expectedChainId,
          );
          return false;
        }
        verifyingContract = domain.verifyingContract as Address;
        chainId = domain.chainId;
        if (domain.name) domainName = domain.name;
        if (domain.version) domainVersion = domain.version;
      } else {
        log("No domain in payment data — using expected token + network chain");
        verifyingContract = expectedVerifyingContract;
        chainId = expectedChainId;
        const usdc = getUsdcContractAddress(network);
        if (expectedVerifyingContract.toLowerCase() === usdc.toLowerCase()) {
          domainName = "USD Coin";
        } else {
          domainName = "Token";
        }
      }

      log("Verifying contract:", verifyingContract, "chainId:", chainId);

      const domain: TypedDataDomain = {
        name: domainName,
        version: domainVersion,
        chainId,
        verifyingContract,
      };

      log("Domain for verification:", domain);

      const types = {
        TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES,
      };

      const message = {
        from: authorization.from as Address,
        to: authorization.to as Address,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter || 0),
        validBefore: BigInt(
          authorization.validBefore || Math.floor(Date.now() / 1000) + 86400,
        ),
        nonce: authorization.nonce as Hex,
      };

      log("Message:", {
        from: message.from,
        to: message.to,
        value: message.value.toString(),
      });

      try {
        const recoveredAddress = await recoverTypedDataAddress({
          domain,
          types,
          primaryType: "TransferWithAuthorization",
          message,
          signature: signature as Hex,
        });

        log(
          "Recovered signer:",
          recoveredAddress,
          "Expected:",
          authorization.from,
        );

        const signerMatches =
          recoveredAddress.toLowerCase() === authorization.from.toLowerCase();

        if (!signerMatches) {
          try {
            const wrongTypeRecovered = await recoverTypedDataAddress({
              domain,
              types: {
                ReceiveWithAuthorization: RECEIVE_WITH_AUTHORIZATION_TYPES,
              },
              primaryType: "ReceiveWithAuthorization",
              message,
              signature: signature as Hex,
            });

            if (
              wrongTypeRecovered.toLowerCase() ===
              authorization.from.toLowerCase()
            ) {
              logError("❌ CLIENT ERROR: Wrong EIP-712 type used");
              return false;
            }
          } catch (_e) {
            log("Could not recover with ReceiveWithAuthorization either");
          }
        }

        log("Signature match:", signerMatches ? "✓ Valid" : "✗ Invalid");

        if (!signerMatches) {
          const userAgent = req?.headers?.["user-agent"];
          const isX402Gateway =
            typeof userAgent === "string" && userAgent.includes("X402-Gateway");

          if (isX402Gateway) {
            log("🔍 Detected X402 Gateway User-Agent");
            const trustedSignersSetting = runtime.getSetting(
              "X402_TRUSTED_GATEWAY_SIGNERS",
            );
            const trustedSigners =
              typeof trustedSignersSetting === "string"
                ? trustedSignersSetting
                : "0x2EB8323f66eE172315503de7325D04c676089267";
            const signerWhitelist = trustedSigners
              .split(",")
              .map((addr: string) => addr.trim().toLowerCase());

            if (signerWhitelist.includes(recoveredAddress.toLowerCase())) {
              log("✅ Signature verified: signed by authorized X402 Gateway");
              return true;
            } else {
              logError(
                `✗ Gateway signer NOT in whitelist: ${recoveredAddress}`,
              );
              logError(
                `Add to X402_TRUSTED_GATEWAY_SIGNERS to allow: ${recoveredAddress}`,
              );
              return false;
            }
          } else {
            logError("✗ Signature verification failed: signer mismatch");
            logError(
              `Expected: ${authorization.from}, Actual: ${recoveredAddress}`,
            );
            return false;
          }
        } else {
          log("✓ Signature cryptographically verified");
          return true;
        }
      } catch (error) {
        logError(
          "✗ Signature verification failed:",
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    } catch (error) {
      logError(
        "EIP-712 verification error:",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  } catch (error) {
    logError(
      "EIP-712 verification error:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * Create a payment-aware route handler
 */
export function createPaymentAwareHandler(
  route: PaymentEnabledRoute,
): NonNullable<Route["handler"]> {
  const originalHandler = route.handler;

  return async (
    req: RouteRequest,
    res: RouteResponse,
    runtime: IAgentRuntime,
  ) => {
    const typedReq = req as X402Request;
    const typedRes = res as ExpressResponse;
    const typedRuntime = runtime as X402Runtime;

    if (route.x402 == null) {
      if (originalHandler) {
        return originalHandler(req, res, runtime);
      }
      return;
    }

    const testMode =
      process.env.X402_TEST_MODE === "true" ||
      process.env.X402_TEST_MODE === "1";
    if (testMode) {
      logger.warn(
        "[@elizaos/agent x402] X402_TEST_MODE is set — skipping payment verification (development only)",
      );
      if (originalHandler) {
        return originalHandler(req, res, runtime);
      }
      return;
    }

    const x402Cfg = resolveEffectiveX402(route, typedRuntime);
    if (!x402Cfg) {
      if (!typedRes.headersSent) {
        typedRes.status(500).json({
          error: "x402 misconfiguration",
          message:
            "Could not resolve x402 price/paymentConfigs. For `x402: true`, set character.settings.x402.defaultPriceInCents and defaultPaymentConfigs. For partial x402 on the route, supply priceInCents and paymentConfigs or the matching character defaults.",
          path: route.path,
        });
      }
      return;
    }

    const payRoute: X402PaidRoute = { ...route, x402: x402Cfg };

    logSection(`X402 Payment Check - ${route.path}`);
    log("Method:", typedReq.method);

    if (route.validator) {
      try {
        const validationResult = await route.validator(typedReq);

        if (!validationResult.valid) {
          logError("✗ Validation failed:", validationResult.error?.message);

          const x402Response = buildX402Response(payRoute, typedRuntime);
          void typedRuntime.emitEvent(X402_EVENT_PAYMENT_REQUIRED, {
            path: route.path,
            configNames: payRoute.x402.paymentConfigs ?? ["base_usdc"],
            reason: "validator_failed",
          });

          const errorMessage = validationResult.error?.details
            ? `${validationResult.error.message}: ${JSON.stringify(validationResult.error.details)}`
            : validationResult.error?.message || "Invalid request parameters";

          setStandardPaymentRequiredHeaders(
            typedRes,
            payRoute,
            typedRuntime,
            errorMessage,
          );
          return typedRes.status(402).json({
            ...x402Response,
            error: errorMessage,
          });
        }

        log("✓ Validation passed");
      } catch (error) {
        logError(
          "✗ Validation error:",
          error instanceof Error ? error.message : String(error),
        );

        const x402Response = buildX402Response(payRoute, typedRuntime);
        void typedRuntime.emitEvent(X402_EVENT_PAYMENT_REQUIRED, {
          path: route.path,
          configNames: payRoute.x402.paymentConfigs ?? ["base_usdc"],
          reason: "validator_error",
        });
        setStandardPaymentRequiredHeaders(
          typedRes,
          payRoute,
          typedRuntime,
          "Validation error",
        );
        return typedRes.status(402).json({
          ...x402Response,
          error: `Validation error: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    }

    log("Headers:", JSON.stringify(typedReq.headers, null, 2));
    log("Query:", JSON.stringify(typedReq.query, null, 2));
    if (typedReq.method === "POST" && typedReq.body) {
      log("Body:", JSON.stringify(typedReq.body, null, 2));
    }

    const paymentProof =
      typedReq.headers["x-payment-proof"] ||
      typedReq.headers["x-payment"] ||
      typedReq.headers["payment-signature"] ||
      typedReq.query?.paymentProof;
    const paymentId =
      typedReq.headers["x-payment-id"] || typedReq.query?.paymentId;

    log("Payment credentials:", {
      "x-payment-proof": !!typedReq.headers["x-payment-proof"],
      "x-payment": !!typedReq.headers["x-payment"],
      "payment-signature": !!typedReq.headers["payment-signature"],
      "x-payment-id": !!paymentId,
      found: !!(paymentProof || paymentId),
    });

    if (paymentProof || paymentId) {
      log("Payment credentials received:", {
        proofLength: paymentProof ? String(paymentProof).length : 0,
        paymentId,
      });

      try {
        const cfgNames = payRoute.x402.paymentConfigs ?? ["base_usdc"];
        const outcome = await verifyPayment({
          paymentProof:
            typeof paymentProof === "string" ? paymentProof : undefined,
          paymentId: typeof paymentId === "string" ? paymentId : undefined,
          route: route.path,
          priceInCents: payRoute.x402.priceInCents,
          paymentConfigNames: cfgNames,
          agentId: typedRuntime.agentId
            ? String(typedRuntime.agentId)
            : undefined,
          runtime: typedRuntime,
          req: typedReq,
        });

        if (outcome.ok) {
          log("✓ PAYMENT VERIFIED - executing handler");
          void typedRuntime.emitEvent(X402_EVENT_PAYMENT_VERIFIED, {
            path: route.path,
            priceInCents: payRoute.x402.priceInCents,
            paymentConfigs: payRoute.x402.paymentConfigs,
            payer: outcome.details.payer,
            amountAtomic: outcome.details.amountAtomic,
            network: outcome.details.network,
            proofId: outcome.details.proofId,
            paymentConfig: outcome.details.paymentConfig,
            symbol: outcome.details.symbol,
          });
          if (outcome.details.paymentResponse && typedRes.setHeader) {
            typedRes.setHeader(
              "PAYMENT-RESPONSE",
              outcome.details.paymentResponse,
            );
            typedRes.setHeader(
              "Access-Control-Expose-Headers",
              "PAYMENT-REQUIRED, PAYMENT-RESPONSE, Payment-Required, Payment-Response",
            );
          }
          if (originalHandler) {
            return originalHandler(req as never, res as never, runtime);
          }
          return;
        }
        logError("✗ PAYMENT VERIFICATION FAILED");
        const x402Base = buildX402Response(payRoute, typedRuntime);
        void typedRuntime.emitEvent(X402_EVENT_PAYMENT_REQUIRED, {
          path: route.path,
          configNames: cfgNames,
          reason: "verification_failed",
        });
        setStandardPaymentRequiredHeaders(
          typedRes,
          payRoute,
          typedRuntime,
          "Payment verification failed",
        );
        typedRes.status(402).json({
          ...x402Base,
          error: "Payment verification failed",
          message:
            "The provided payment proof is invalid or has expired, or the amount or token does not match this route.",
        });
        return;
      } catch (error) {
        logError(
          "✗ PAYMENT VERIFICATION ERROR:",
          error instanceof Error ? error.message : String(error),
        );
        let x402Base: X402Response;
        try {
          x402Base = buildX402Response(payRoute, typedRuntime);
        } catch {
          x402Base = createX402Response({
            error: "Payment verification error",
          });
        }
        void typedRuntime.emitEvent(X402_EVENT_PAYMENT_REQUIRED, {
          path: route.path,
          configNames: payRoute.x402.paymentConfigs ?? ["base_usdc"],
          reason: "verification_error",
        });
        setStandardPaymentRequiredHeaders(
          typedRes,
          payRoute,
          typedRuntime,
          "Payment verification error",
        );
        typedRes.status(402).json({
          ...x402Base,
          error: "Payment verification error",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }

    log("No payment credentials - returning 402");

    try {
      const x402Response = buildX402Response(payRoute, typedRuntime);
      void typedRuntime.emitEvent(X402_EVENT_PAYMENT_REQUIRED, {
        path: route.path,
        configNames: payRoute.x402.paymentConfigs ?? ["base_usdc"],
        reason: "payment_required",
      });
      log("Payment options:", {
        paymentConfigs: payRoute.x402.paymentConfigs || ["base_usdc"],
        priceInCents: payRoute.x402.priceInCents,
        count: x402Response.accepts?.length || 0,
      });
      log("402 Response:", JSON.stringify(x402Response, null, 2));

      setStandardPaymentRequiredHeaders(
        typedRes,
        payRoute,
        typedRuntime,
        "Payment Required",
      );
      typedRes.status(402).json(x402Response);
    } catch (error) {
      logError(
        "✗ Failed to build x402 response:",
        error instanceof Error ? error.message : String(error),
      );
      typedRes.status(402).json(
        createX402Response({
          error: `Payment Required: ${error instanceof Error ? error.message : "Unknown error"}`,
        }),
      );
    }
  };
}

/**
 * Attach x402 **V2** `PAYMENT-REQUIRED` while still returning the **legacy JSON** 402 body.
 *
 * **Why both:** many readers still consume `accepts` from JSON (`x402Version: 1`);
 * V2 buyers expect a base64 `PaymentRequired` object in `PAYMENT-REQUIRED`
 * (`x402Version: 2`, CAIP-2 `network`, etc.). Shipping both avoids breaking older
 * integrations while giving spec-aligned clients a deterministic header to parse.
 *
 * **Why base64:** per x402 V2 HTTP docs, header values are base64-encoded JSON so
 * proxies and intermediaries do not mangle structured characters.
 */
function setStandardPaymentRequiredHeaders(
  res: ExpressResponse,
  route: X402PaidRoute,
  runtime?: X402Runtime,
  error = "Payment Required",
): void {
  if (!res.setHeader || res.headersSent) return;
  const paymentConfigNames = route.x402.paymentConfigs || ["base_usdc"];
  const agentId = runtime?.agentId ? String(runtime.agentId) : undefined;
  const paymentRequired = buildStandardPaymentRequired({
    routePath: route.path,
    description: generateDescription(route),
    priceInCents: route.x402.priceInCents,
    paymentConfigNames,
    agentId,
    error,
  });
  const encoded = Buffer.from(JSON.stringify(paymentRequired), "utf8").toString(
    "base64",
  );
  res.setHeader("PAYMENT-REQUIRED", encoded);
  res.setHeader(
    "Access-Control-Expose-Headers",
    "PAYMENT-REQUIRED, PAYMENT-RESPONSE, Payment-Required, Payment-Response",
  );
}

/**
 * Build x402scan-compliant response for a route
 */
function buildX402Response(
  route: X402PaidRoute,
  runtime?: X402Runtime,
): X402Response {
  if (!route.x402.priceInCents) {
    throw new Error("Route x402.priceInCents is required for x402 response");
  }

  const paymentConfigs = route.x402.paymentConfigs || ["base_usdc"];
  const agentId = runtime?.agentId ? String(runtime.agentId) : undefined;

  const accepts = paymentConfigs.flatMap((configName) => {
    const config = getPaymentConfig(configName, agentId);
    const caip19 = getCAIP19FromConfig(config);
    const maxAmountRequired = atomicAmountForPriceInCents(
      route.x402.priceInCents,
      config,
    );

    const inputSchema = buildInputSchemaFromRoute(route);

    const method = route.type === "POST" ? "POST" : "GET";

    const outputSchema: OutputSchema = {
      input: {
        type: "http",
        method: method,
        bodyType: method === "POST" ? "json" : undefined,
        pathParams: inputSchema.pathParams,
        queryParams: inputSchema.queryParams,
        bodyFields: inputSchema.bodyFields,
        headerFields: {
          "X-Payment": {
            type: "string",
            required: false,
            description:
              "Standard x402 payment header (base64-encoded JSON or raw JSON with x402Version, accepted, payload) — verified via facilitator POST when configured",
          },
          "X-Payment-Proof": {
            type: "string",
            required: false,
            description:
              "Legacy payment proof (tx hash, colon-delimited, or JSON)",
          },
          "X-Payment-Id": {
            type: "string",
            required: false,
            description: "Optional payment ID for tracking",
          },
        },
      },
      output: {
        type: "object",
        description: "API response data (varies by endpoint)",
      },
    };

    const extra: PaymentExtraMetadata = {
      priceInCents: route.x402.priceInCents || 0,
      priceUSD: `$${((route.x402.priceInCents || 0) / 100).toFixed(2)}`,
      symbol: config.symbol,
      paymentConfig: configName,
      expiresIn: 300, // Payment window in seconds
    };

    // Add EIP-712 domain for EVM chains (helps client developers)
    if (
      config.network === "BASE" ||
      config.network === "POLYGON" ||
      config.network === "BSC"
    ) {
      const isUsdc = config.symbol?.toUpperCase() === "USDC";
      const tokenName = isUsdc ? "USD Coin" : config.symbol || "Token";
      extra.name = tokenName;
      extra.version = "2";
      extra.eip712Domain = {
        name: tokenName,
        version: "2",
        chainId: Number.parseInt(config.chainId || "1", 10),
        verifyingContract: config.assetReference,
      };
    }

    return createAccepts({
      network: toX402Network(config.network),
      maxAmountRequired,
      resource: toResourceUrl(route.path),
      description: generateDescription(route),
      payTo: config.paymentAddress,
      asset: caip19,
      mimeType: "application/json",
      maxTimeoutSeconds: 300,
      outputSchema,
      extra,
    });
  });

  return createX402Response({
    accepts,
    error: "Payment Required",
  });
}

/**
 * Extract path parameter names from Express-style route path
 */
function extractPathParams(path: string): string[] {
  const matches = path.matchAll(/:([^/]+)/g);
  return Array.from(matches, (m) => m[1]);
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
  type: "object";
  required?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenAPIObjectSchema(schema: unknown): schema is OpenAPIObjectSchema {
  if (!isRecord(schema) || schema.type !== "object") {
    return false;
  }
  const properties = schema.properties;
  return (
    properties === undefined ||
    (isRecord(properties) &&
      Object.values(properties).every(
        (property) => property === undefined || isRecord(property),
      ))
  );
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
function convertOpenAPISchemaToFieldDef(
  schema: OpenAPIObjectSchema | OpenAPIPropertySchema,
): Record<string, FieldDefinition> {
  if ("properties" in schema && schema.properties) {
    const fields: Record<string, FieldDefinition> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      fields[key] = {
        type: value.type,
        required:
          "required" in schema && schema.required
            ? schema.required.includes(key)
            : false,
        description: value.description,
        enum: value.enum,
        pattern: value.pattern,
        properties: value.properties
          ? convertOpenAPISchemaToFieldDef(value)
          : undefined,
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
    const pathParams: Record<string, FieldDefinition> = {};
    for (const p of route.openapi.parameters.filter((x) => x.in === "path")) {
      pathParams[p.name] = {
        type: p.schema.type,
        required: p.required ?? true,
        description: p.description,
        enum: p.schema.enum,
        pattern: p.schema.pattern,
      };
    }
    if (Object.keys(pathParams).length > 0) schema.pathParams = pathParams;
  } else {
    const paramNames = extractPathParams(route.path);
    if (paramNames.length > 0) {
      const pathParams: Record<string, FieldDefinition> = {};
      for (const name of paramNames) {
        pathParams[name] = {
          type: "string",
          required: true,
          description: `Path parameter: ${name}`,
        };
      }
      schema.pathParams = pathParams;
    }
  }

  if (route.openapi?.parameters) {
    const queryParams: Record<string, FieldDefinition> = {};
    for (const p of route.openapi.parameters.filter((x) => x.in === "query")) {
      queryParams[p.name] = {
        type: p.schema.type,
        required: p.required ?? false,
        description: p.description,
        enum: p.schema.enum,
        pattern: p.schema.pattern,
      };
    }
    if (Object.keys(queryParams).length > 0) schema.queryParams = queryParams;
  }

  if (route.openapi?.requestBody?.content?.["application/json"]?.schema) {
    const requestBodySchema =
      route.openapi.requestBody.content["application/json"].schema;
    if (isOpenAPIObjectSchema(requestBodySchema)) {
      schema.bodyFields = convertOpenAPISchemaToFieldDef(requestBodySchema);
    }
  }

  return schema;
}

/**
 * Auto-generate description from route path if not provided
 */
function generateDescription(route: PaymentEnabledRoute): string {
  if (route.description) return route.description;

  const pathParts = route.path.split("/").filter(Boolean);
  const action = route.type.toLowerCase() === "get" ? "Get" : "Execute";
  const resource =
    pathParts[pathParts.length - 1]?.replace(/^:/, "") || "resource";
  return `${action} ${resource}`;
}

// Re-export types from core
export type { X402RequestValidator, X402ValidationResult } from "@elizaos/core";

/**
 * Apply payment protection to an array of routes
 * Runs comprehensive startup validation before applying protection. Pass
 * `character`/`agentId` so routes that use the `x402: true` shorthand (which
 * resolves price + paymentConfigs from `character.settings.x402`) can validate
 * without errors.
 */
export function applyPaymentProtection(
  routes: Route[],
  context?: { character?: Character; agentId?: string },
): Route[] {
  if (!Array.isArray(routes)) {
    throw new Error("routes must be an array");
  }

  const validation = validateX402Startup(routes, context?.character, {
    agentId: context?.agentId,
  });

  if (!validation.valid) {
    throw new Error(
      `\nx402 Configuration Invalid (${validation.errors.length} error${validation.errors.length > 1 ? "s" : ""}):\n\n` +
        validation.errors.map((e) => `  • ${e}`).join("\n") +
        "\n\nPlease fix these errors and try again.\n",
    );
  }

  return routes.map((route) => {
    const x402Route = route as PaymentEnabledRoute;
    if (x402Route.x402 != null) {
      logger.debug(
        { path: x402Route.path, x402: x402Route.x402 },
        "[x402] payment protection enabled",
      );

      const wrappedRoute: Route & { [X402_ROUTE_PAYMENT_WRAPPED]: true } = {
        ...route,
        handler: createPaymentAwareHandler(x402Route),
        [X402_ROUTE_PAYMENT_WRAPPED]: true,
      };
      return wrappedRoute;
    }
    return route;
  });
}
