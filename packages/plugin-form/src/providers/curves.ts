import {
    type IAgentRuntime,
    type Memory,
    type Provider,
    type State,
    elizaLogger,
} from "@elizaos/core";
import { CURVES_ADDRESSES, CurvesType } from "../utils/addresses";
import form from "../chains/form";
import formTestnet from "../chains/form.testnet";

/**
 * Template for determining the correct curves formula based on context.
 * Can be embedded in other templates using {{formulaTemplate}}
 */
export const formulaGuideTemplate = `Formula Determination Guide:

LOGRITHMIC Formula (Required for Scale):
- Usage: Large-scale, high-volume, or stable-price scenarios
- Keywords that MUST trigger LOGRITHMIC:
  * "large groups", "mass market", "broad adoption"
  * "high volume", "heavy trading", "frequent trades"
  * "stable pricing", "price stability"
  * "expansive", "massive", "broad", "big"
  * Any mention of scale, size, or numerous participants
- Example contexts:
  * Community platforms expecting many participants
  * Trading venues with high transaction volumes
  * Scenarios requiring price stability
  * Large-scale social networks or communities

QUADRATIC Formula (Default Choice):
- Usage: Standard curves for regular use cases
- Appropriate for:
  * "small groups", "personal use", "intimate settings"
  * "exclusive", "niche", "specialized"
  * Individual users or small communities
  * When no specific scale is mentioned
- Example contexts:
  * Personal token collections
  * Small community groups
  * Individual creator tokens
  * Default when scale isn't specified

Decision Rules:
1. ANY mention of scale or volume → MUST use LOGRITHMIC
2. Explicit small-scale context → use QUADRATIC
3. No scale indicators → default to QUADRATIC

Example Mappings:
- "large community" → LOGRITHMIC
- "my personal token" → QUADRATIC
- "mass adoption" → LOGRITHMIC
- "friend group" → QUADRATIC
- "broad reach" → LOGRITHMIC`;

export const curvesFormulaProvider: Provider = {
    get: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
        const isTestnet = runtime.getSetting("FORM_TESTNET") === "true";
        const chain = isTestnet ? formTestnet : form;

        elizaLogger.debug(
            `[plugin-form][curves-formula-provider] getting formulas for chain ${chain.name}`
        );

        const formulas = Object.entries(CURVES_ADDRESSES[chain.id])
            .map(
                ([formula, address]) =>
                    `- ${formula}: ${address}\n  Use case: ${
                        formula === "LOGRITHMIC"
                            ? "Large-scale/high-volume scenarios requiring price stability"
                            : "Standard scenarios and personal/small group usage"
                    }`
            )
            .join("\n");

        const output = `\n!!! Available Curves Formulas on ${chain.name} !!!:
${formulas}

${formulaGuideTemplate}

Note: When no explicit formula is mentioned, analyze the context carefully using the guide above. The choice of formula significantly impacts price stability and trading behavior.\n`;

        elizaLogger.debug(
            "[plugin-form][curves-formula-provider] output:",
            output
        );

        return output;
    },
};
