/**
 * Aegis-12 SDK — Zero-Custody TEE Remote Signer
 *
 * This SDK routes unsigned intents to a Phala TEE enclave for
 * hardware-attested signing. Agents NEVER hold private keys.
 */

export interface AegisIntent {
    toolId: string;
    parameters: {
        to: string;
        amount: number;
        token: string;
        [key: string]: unknown;
    };
}

export interface AegisConfig {
    /** Gateway URL. No default — must be explicitly configured. */
    gatewayUrl: string;
    agentId: string;
    tenantId: string;
    mandateSignature: string;
    agentTier?: string;
    timeoutMs?: number;
    currentAnomalyScore?: number;
}

export interface AegisResult {
    status: 'approved' | 'escalated';
    decision: 'ALLOW' | 'ESCALATED';
    tx_hash?: string;
    evidence_package?: Record<string, unknown>;
    hardware_attestation?: string;
    envelope?: Record<string, unknown>;
}

interface GatewayPayload {
    agent: { id: string; tenantId: string; currentTier: string };
    action: { toolId: string; parameters: Record<string, unknown> };
    context: { timestamp: string; currentAnomalyScore: number };
    mandateSignature: string;
}

export class AegisSDK {
    /**
     * signAndExecute — The Drop-in SDK for the TEE Remote Signer.
     * The agent passes an unsigned intent. The Phala TEE enforces
     * the AP2 Intent Mandate, signs the transaction securely,
     * submits via Jito ShredStream, and returns the tx_hash and
     * Evidence Package.
     */
    static async signAndExecute(intent: AegisIntent, config: AegisConfig): Promise<AegisResult> {
        if (!config.gatewayUrl) {
            throw new Error('[Aegis SDK] gatewayUrl is required. Refusing to use a default endpoint.');
        }
        if (!config.mandateSignature) {
            throw new Error('[Aegis SDK] mandateSignature is required. Agents cannot operate without a signed mandate.');
        }

        const timeoutMs = config.timeoutMs ?? 5000;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const payload = AegisSDK._buildPayload(intent, config);
            const decision = await AegisSDK._postRequest(config.gatewayUrl, payload, controller);
            return AegisSDK._formatResponse(decision);
        } finally {
            clearTimeout(timeout);
        }
    }

    private static _buildPayload(intent: AegisIntent, config: AegisConfig): GatewayPayload {
        return {
            agent: {
                id: config.agentId,
                tenantId: config.tenantId,
                currentTier: config.agentTier ?? 'T1',
            },
            action: {
                toolId: intent.toolId,
                parameters: intent.parameters,
            },
            context: {
                timestamp: new Date().toISOString(),
                // Default to 1.0 (maximum suspicion) — fail-closed
                currentAnomalyScore: config.currentAnomalyScore ?? 1.0,
            },
            mandateSignature: config.mandateSignature,
        };
    }

    private static async _postRequest(
        gatewayUrl: string,
        payload: GatewayPayload,
        controller: AbortController,
    ): Promise<Record<string, unknown>> {
        const base = gatewayUrl.replace(/\/+$/, '');
        const url = base.endsWith('/sign_and_execute')
            ? base
            : `${base}/sign_and_execute`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!response.ok) {
            let errorMessage = response.statusText;
            try {
                const errorData = (await response.json()) as { error?: string };
                if (errorData.error) {
                    // Sanitize: strip tags and limit length to prevent injection/log-poisoning
                    errorMessage = errorData.error.replace(/[<>]/g, '').slice(0, 200);
                }
            } catch {
                // If body isn't JSON, use statusText
            }
            throw new Error(`Aegis Fiduciary Escrow Rejected (HTTP ${response.status}): ${errorMessage}`);
        }

        return (await response.json()) as Record<string, unknown>;
    }

    private static _formatResponse(decision: Record<string, unknown>): AegisResult {
        const status = decision.status as string | undefined;

        if (status !== 'approved' && status !== 'escalated') {
            const rawError = (decision.error as string) ?? 'Intent Mandate Violation';
            const safeError = rawError.replace(/[<>]/g, '').slice(0, 200);
            throw new Error(`Aegis Fiduciary Escrow Denied: ${safeError}`);
        }

        return {
            status: status as 'approved' | 'escalated',
            decision: status === 'approved' ? 'ALLOW' : 'ESCALATED',
            tx_hash: (decision.tx_hash ?? decision.ledger_tx) as string | undefined,
            evidence_package: decision.receipt
                ? ((decision.receipt as Record<string, unknown>).evidencePackage as Record<string, unknown>)
                : undefined,
            hardware_attestation: decision.attestation as string | undefined,
            envelope: decision.ars_anchor as Record<string, unknown> | undefined,
        };
    }
}
