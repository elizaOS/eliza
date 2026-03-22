import {
    type Action,
    type IAgentRuntime,
    type Memory,
    type Plugin,
    type State,
    type HandlerCallback,
    elizaLogger,
} from "@elizaos/core";

const SAFETYMD_API_BASE = "https://safetymd.p-u-c.workers.dev/v1/check";
const FETCH_TIMEOUT_MS = 3000;

// Matches 0x Ethereum-style addresses (40 hex chars)
const ADDRESS_REGEX = /0x[a-fA-F0-9]{40}/g;

interface SafetyMdResponse {
    safe: boolean;
    risk: "low" | "medium" | "high" | "critical";
    reason: string;
    service?: Record<string, unknown>;
    signals?: Record<string, unknown>;
}

async function checkAddress(
    address: string,
    chain = "ethereum"
): Promise<SafetyMdResponse | null> {
    const url = `${SAFETYMD_API_BASE}/${address}?chain=${chain}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) {
            elizaLogger.warn(`[safety-md] API returned ${res.status} for ${address}`);
            return null;
        }
        return (await res.json()) as SafetyMdResponse;
    } catch (err) {
        clearTimeout(timer);
        elizaLogger.warn(`[safety-md] fetch failed for ${address}: ${err}`);
        return null; // fail open
    }
}

function riskEmoji(risk: string): string {
    return { low: "✅", medium: "⚠️", high: "🚨", critical: "🛑" }[risk] ?? "❓";
}

function formatResult(address: string, result: SafetyMdResponse | null): string {
    if (!result) {
        return `⚠️ Could not check address ${address} — please verify manually before sending funds.`;
    }

    const emoji = riskEmoji(result.risk);
    const safetyLabel = result.safe ? "SAFE" : "UNSAFE";
    let msg = `${emoji} **${address}**\n`;
    msg += `Risk: **${result.risk.toUpperCase()}** (${safetyLabel})\n`;
    msg += `Reason: ${result.reason}`;

    if (result.signals && Object.keys(result.signals).length > 0) {
        const sigLines = Object.entries(result.signals)
            .map(([k, v]) => `  • ${k}: ${v}`)
            .join("\n");
        msg += `\nSignals:\n${sigLines}`;
    }

    if (!result.safe) {
        msg += "\n\n🚫 **Do not send funds to this address.**";
    }

    return msg;
}

export const checkPaymentAddressAction: Action = {
    name: "CHECK_PAYMENT_ADDRESS",
    similes: ["VERIFY_ADDRESS", "IS_ADDRESS_SAFE", "CHECK_ADDRESS", "ADDRESS_SAFETY_CHECK"],
    description:
        "Check if an Ethereum/EVM payment address is safe before sending funds using the safety.md API.",

    validate: async (
        _runtime: IAgentRuntime,
        message: Memory
    ): Promise<boolean> => {
        const text = message.content?.text ?? "";
        return ADDRESS_REGEX.test(text);
    },

    handler: async (
        _runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        _options: Record<string, unknown>,
        callback: HandlerCallback
    ): Promise<boolean> => {
        const text = message.content?.text ?? "";
        // Reset lastIndex since ADDRESS_REGEX is global
        ADDRESS_REGEX.lastIndex = 0;
        const addresses = [...text.matchAll(ADDRESS_REGEX)].map((m) => m[0]);

        if (addresses.length === 0) {
            await callback({
                text: "No Ethereum addresses found in your message. Please include a 0x address to check.",
            });
            return false;
        }

        // Check up to 3 addresses to stay within free-tier limits
        const toCheck = addresses.slice(0, 3);
        const results = await Promise.all(
            toCheck.map((addr) => checkAddress(addr))
        );

        const lines = toCheck.map((addr, i) => formatResult(addr, results[i]));
        const responseText = lines.join("\n\n---\n\n");

        await callback({ text: responseText });
        return true;
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you check if 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 is a safe address to send ETH to?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "✅ **0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045**\nRisk: **LOW** (SAFE)\nReason: No malicious signals detected. Address appears to be a known ENS-linked wallet.",
                    action: "CHECK_PAYMENT_ADDRESS",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Is 0x000000000000000000000000000000000000dEaD safe?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "⚠️ **0x000000000000000000000000000000000000dEaD**\nRisk: **MEDIUM** (SAFE)\nReason: This is a well-known burn address. Sending funds here is irreversible — they will be permanently destroyed.",
                    action: "CHECK_PAYMENT_ADDRESS",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Someone asked me to send USDC to 0xAbCdEf1234567890AbCdEf1234567890AbCdEf12 — should I?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "🚨 **0xAbCdEf1234567890AbCdEf1234567890AbCdEf12**\nRisk: **HIGH** (UNSAFE)\nReason: Address flagged for involvement in phishing campaigns.\n\n🚫 **Do not send funds to this address.**",
                    action: "CHECK_PAYMENT_ADDRESS",
                },
            },
        ],
    ],
};

export const safetyMdPlugin: Plugin = {
    name: "safety-md",
    description:
        "Verify EVM payment address safety before sending funds using the safety.md API. Flags high-risk, scam, and blacklisted addresses.",
    actions: [checkPaymentAddressAction],
    evaluators: [],
    providers: [],
};

export default safetyMdPlugin;
