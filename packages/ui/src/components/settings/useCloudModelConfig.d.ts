/**
 * State + save logic for the Eliza Cloud model tier dropdowns.
 *
 * Extracted from ProviderSwitcher so the orchestrator stays a thin
 * compositional shell. Persists tier picks via /api/config update +
 * agent restart, surfaces saving/success state, and exposes the
 * derived modelValues used by the cloud-tier ConfigRenderer.
 */
import { type ModelOption } from "@elizaos/shared";
import { type OnboardingOptions } from "../../api";
import { type CloudModelSchema } from "./cloud-model-schema";
export interface CloudModelConfig {
    modelOptions: OnboardingOptions["models"] | null;
    setModelOptions: (options: OnboardingOptions["models"]) => void;
    initializeFromConfig: (cfg: Record<string, unknown>, elizaCloudEnabledCfg: boolean) => void;
    cloudModelSchema: CloudModelSchema | null;
    largeModelOptions: ModelOption[];
    currentLargeModel: string;
    modelValues: {
        values: Record<string, unknown>;
        setKeys: Set<string>;
    };
    modelSaving: boolean;
    modelSaveSuccess: boolean;
    handleModelFieldChange: (key: string, value: unknown) => void;
}
export declare function useCloudModelConfig(onSaveError: (prefix: string, err: unknown) => void): CloudModelConfig;
//# sourceMappingURL=useCloudModelConfig.d.ts.map