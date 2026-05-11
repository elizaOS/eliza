import { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { AegisSDK } from "../sdk/AegisSDK";
import type { AegisIntent } from "../sdk/AegisSDK";

/**
 * Strict regex: requires "transfer" or "send" as a whole word,
 * followed by a numeric amount and a token symbol (USDC or SOL).
 * This prevents false positives on words like "console", "solution", etc.
 */
const FINANCIAL_INTENT_PATTERN = /\b(?:transfer|send)\b.*?\d+(?:\.\d+)?\s*(?:USDC|SOL)\b/i;

/**
 * Strict amount regex: matches a valid decimal number (not "1.2.3.4")
 * followed by whitespace and token symbol.
 */
const AMOUNT_PATTERN = /(\d+(?:\.\d+)?)\s+(USDC|SOL)\b/i;

/**
 * Address extraction: requires the word "to" followed by a valid
 * Base58 Solana address (32-44 chars). Uses a capture group on
 * the address only, so source addresses mentioned before "to"
 * are never captured.
 */
const DESTINATION_PATTERN = /\bto\s+([1-9A-HJ-NP-Za-km-z]{32,44})\b/i;

/** Sanitize a string for safe inclusion in agent messages. */
function sanitize(input: string, maxLength = 200): string {
    return input
        .replace(/[<>]/g, '') // strip HTML-like tags
        .slice(0, maxLength);  // truncate
}

export const evaluateIntentAction: Action = {
    name: "EVALUATE_INTENT",
    similes: ["EXECUTE_COMPLIANT_TRANSFER", "AEGIS_TRANSFER", "SEND_FUNDS_SECURELY"],
    description: "Intercepts a financial transaction and routes it through the Aegis-12 TEE Fiduciary Firewall.",

    validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
        const content = typeof message.content === 'string'
            ? message.content
            : message.content?.text ?? '';
        return FINANCIAL_INTENT_PATTERN.test(content);
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options?: Record<string, unknown>,
        callback?: HandlerCallback,
    ): Promise<boolean> => {
        const text = typeof message.content === 'string'
            ? message.content
            : message.content?.text ?? '';

        // --- 1. Parse amount ---
        const amountMatch = text.match(AMOUNT_PATTERN);
        if (!amountMatch) {
            await callback?.({
                text: "❌ ACTION HALTED: Could not extract a valid amount and token from the intent.",
                action: "EVALUATE_INTENT",
            });
            return false;
        }
        const amount = parseFloat(amountMatch[1]);
        const token = amountMatch[2].toUpperCase();

        if (!Number.isFinite(amount) || amount <= 0) {
            await callback?.({
                text: "❌ ACTION HALTED: Invalid transfer amount.",
                action: "EVALUATE_INTENT",
            });
            return false;
        }

        // --- 2. Parse destination address (must appear after "to") ---
        const addressMatch = text.match(DESTINATION_PATTERN);
        if (!addressMatch) {
            await callback?.({
                text: "❌ ACTION HALTED: Could not extract a valid destination address. Expected format: 'to <Base58Address>'.",
                action: "EVALUATE_INTENT",
            });
            return false;
        }
        const toAddress = addressMatch[1];

        // --- 3. Validate configuration (fail-fast, no silent defaults) ---
        const aegisUrl = runtime.getSetting?.("AEGIS_GATEWAY_URL") ?? process.env.AEGIS_GATEWAY_URL;
        if (!aegisUrl) {
            await callback?.({
                text: "❌ ACTION HALTED: AEGIS_GATEWAY_URL is not configured. Cannot route intent.",
                action: "EVALUATE_INTENT",
            });
            return false;
        }

        const mandateSignature = runtime.getSetting?.("AEGIS_MANDATE_SIGNATURE") ?? process.env.AEGIS_MANDATE_SIGNATURE;
        if (!mandateSignature) {
            await callback?.({
                text: "❌ ACTION HALTED: AEGIS_MANDATE_SIGNATURE is not configured. Fiduciary Escrow cannot operate.",
                action: "EVALUATE_INTENT",
            });
            return false;
        }

        const tenantId = runtime.getSetting?.("AEGIS_TENANT_ID") ?? process.env.AEGIS_TENANT_ID;
        if (!tenantId) {
            await callback?.({
                text: "❌ ACTION HALTED: AEGIS_TENANT_ID is not configured. Multi-tenant policy isolation requires an explicit tenant.",
                action: "EVALUATE_INTENT",
            });
            return false;
        }

        // --- 4. Build typed intent ---
        const unsignedIntent: AegisIntent = {
            toolId: "solana_transfer",
            parameters: {
                to: toAddress,
                amount,
                token,
            },
        };

        // --- 5. Execute via TEE gateway ---
        try {
            const rawScore = parseFloat(runtime.getSetting?.("AEGIS_ANOMALY_SCORE") ?? '0.1');
            const anomalyScore = Number.isFinite(rawScore) ? Math.max(0, Math.min(1, rawScore)) : 1.0;
            const result = await AegisSDK.signAndExecute(unsignedIntent, {
                agentId: sanitize(runtime.agentId ?? "unknown-agent", 64),
                tenantId,
                mandateSignature,
                gatewayUrl: aegisUrl,
                currentAnomalyScore: anomalyScore,
            });

            if (result.status === 'escalated') {
                await callback?.({
                    text: `⚠️ ACTION HALTED: Human-On-The-Loop triggered. Amount (${amount} ${token}) exceeds autonomous threshold. Waiting for Squads V4 Multisig approval.`,
                    action: "EVALUATE_INTENT",
                    content: result,
                });
                return true;
            }

            await callback?.({
                text: `✅ ACTION APPROVED. Proof of Intent verified. Tx: ${result.tx_hash ?? 'pending'}`,
                action: "EVALUATE_INTENT",
                content: result,
            });
            return true;
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : 'Unknown error';
            await callback?.({
                text: `❌ ACTION DENIED: Fiduciary Escrow rejected the transaction. Reason: ${sanitize(errMsg)}`,
                action: "EVALUATE_INTENT",
            });
            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Transfer 500 USDC to 4jKwb8h2vWjZkLzM6pBxk7tUqVbWv8W4u1gL7tFk5g6k" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "✅ ACTION APPROVED. Proof of Intent verified. Tx: pending",
                    action: "EVALUATE_INTENT",
                },
            },
        ],
    ],
};
