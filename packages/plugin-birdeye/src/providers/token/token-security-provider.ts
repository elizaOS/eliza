import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";
import {
    BASE_URL,
    Chain,
    extractChain,
    extractContractAddresses,
    makeApiRequest,
} from "../utils";

// Types
interface SecurityData {
    isHoneypot: boolean;
    isProxy: boolean;
    isVerified: boolean;
    isAudited: boolean;
    isRenounced: boolean;
    isMintable: boolean;
    isPausable: boolean;
    hasBlacklist: boolean;
    hasFeeOnTransfer: boolean;
    transferFeePercentage: number;
    riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    riskFactors: string[];
}

interface SecurityResponse {
    data: SecurityData;
    token: string;
}

// Constants
const SECURITY_KEYWORDS = [
    "security",
    "risk",
    "audit",
    "safety",
    "honeypot",
    "scam",
    "safe",
    "verified",
    "contract security",
    "token security",
    "token safety",
    "token risk",
    "token audit",
    "security check",
    "risk check",
    "safety check",
] as const;

// Helper functions
const containsSecurityKeyword = (text: string): boolean => {
    return SECURITY_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getTokenSecurity = async (
    apiKey: string,
    contractAddress: string,
    chain: Chain
): Promise<SecurityResponse | null> => {
    try {
        const params = new URLSearchParams({
            address: contractAddress,
        });
        const url = `${BASE_URL}/token/security?${params.toString()}`;

        elizaLogger.info(
            `Fetching security data for ${contractAddress} on ${chain} from:`,
            url
        );

        return await makeApiRequest<SecurityResponse>(url, { apiKey, chain });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching security data:", error.message);
        }
        return null;
    }
};

const getRiskEmoji = (riskLevel: SecurityData["riskLevel"]): string => {
    switch (riskLevel) {
        case "LOW":
            return "✅";
        case "MEDIUM":
            return "⚠️";
        case "HIGH":
            return "🚨";
        case "CRITICAL":
            return "💀";
        default:
            return "❓";
    }
};

const formatSecurityFeatures = (data: SecurityData): string => {
    const features = [
        { name: "Contract Verified", value: data.isVerified },
        { name: "Contract Audited", value: data.isAudited },
        { name: "Ownership Renounced", value: data.isRenounced },
        { name: "Mintable Token", value: data.isMintable },
        { name: "Pausable Token", value: data.isPausable },
        { name: "Has Blacklist", value: data.hasBlacklist },
        { name: "Has Transfer Fee", value: data.hasFeeOnTransfer },
    ];

    return features
        .map(({ name, value }) => `• ${name}: ${value ? "✅" : "❌"}`)
        .join("\n");
};

const analyzeSecurityRisks = (data: SecurityData): string => {
    let analysis = "";

    // Critical checks
    if (data.isHoneypot) {
        analysis +=
            "🚫 CRITICAL: Token is identified as a honeypot! DO NOT TRADE.\n";
    }

    if (data.isProxy) {
        analysis +=
            "⚠️ Contract is upgradeable (proxy). Owner can modify functionality.\n";
    }

    // Fee analysis
    if (data.hasFeeOnTransfer) {
        const feeLevel = data.transferFeePercentage > 5 ? "High" : "Standard";
        analysis += `💸 ${feeLevel} transfer fee (${data.transferFeePercentage}%).\n`;
    }

    // Contract security
    if (!data.isVerified) {
        analysis += "⚠️ Contract is not verified. Cannot audit code.\n";
    }
    if (!data.isAudited) {
        analysis += "⚠️ No professional audit found.\n";
    }
    if (!data.isRenounced) {
        analysis +=
            "👤 Contract ownership retained. Owner can modify contract.\n";
    }

    // Token features
    if (data.isMintable) {
        analysis += "📈 Token supply can be increased by owner.\n";
    }
    if (data.isPausable) {
        analysis += "⏸️ Trading can be paused by owner.\n";
    }
    if (data.hasBlacklist) {
        analysis += "🚫 Addresses can be blacklisted from trading.\n";
    }

    // Risk factors
    if (data.riskFactors.length > 0) {
        analysis += "\nIdentified Risk Factors:\n";
        data.riskFactors.forEach((factor) => {
            analysis += `• ${factor}\n`;
        });
    }

    return analysis;
};

const formatSecurityResponse = (
    data: SecurityResponse,
    chain: Chain
): string => {
    const { data: securityData } = data;
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);

    let response = `Security Analysis for ${data.token} on ${chainName}\n\n`;

    // Overall Risk Level
    response += `🎯 Risk Level: ${getRiskEmoji(securityData.riskLevel)} ${securityData.riskLevel}\n\n`;

    // Security Analysis
    response += "🔍 Security Analysis\n";
    response += analyzeSecurityRisks(securityData) + "\n\n";

    // Contract Features
    response += "📋 Contract Features\n";
    response += formatSecurityFeatures(securityData);

    return response;
};

export const tokenSecurityProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State
    ): Promise<string | null> => {
        const apiKey = runtime.getSetting("BIRDEYE_API_KEY");
        if (!apiKey) {
            elizaLogger.error("BIRDEYE_API_KEY not found in runtime settings");
            return null;
        }

        const messageText = message.content.text;

        if (!containsSecurityKeyword(messageText)) {
            return null;
        }

        const addresses = extractContractAddresses(messageText);
        if (addresses.length === 0) {
            return null;
        }

        const chain = extractChain(messageText);

        elizaLogger.info(
            `TOKEN SECURITY provider activated for ${addresses[0]} on ${chain}`
        );

        const securityData = await getTokenSecurity(
            apiKey,
            addresses[0],
            chain
        );

        if (!securityData) {
            return null;
        }

        return formatSecurityResponse(securityData, chain);
    },
};
