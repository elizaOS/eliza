import type { ModelOption } from "@elizaos/shared";
import type { CloudModelSchema } from "./cloud-model-schema";
export interface ProviderRoutingPanelProps {
  /** All cloud large-tier models, used for the visible primary dropdown. */
  largeModelOptions: ModelOption[];
  /** Full cloud tier schema (nano/small/medium/large/mega + overrides). */
  cloudModelSchema: CloudModelSchema | null;
  /** Current model values keyed by tier id. */
  modelValues: {
    values: Record<string, unknown>;
    setKeys: Set<string>;
  };
  currentLargeModel: string;
  modelSaving: boolean;
  modelSaveSuccess: boolean;
  onModelFieldChange: (key: string, value: unknown) => void;
  localEmbeddings: boolean;
  onToggleLocalEmbeddings: (next: boolean) => void;
  /** Show the local-embeddings + model-overrides UI only when cloud is the active route. */
  showCloudControls: boolean;
  elizaCloudConnected: boolean;
}
export declare function ProviderRoutingPanel({
  largeModelOptions,
  cloudModelSchema,
  modelValues,
  currentLargeModel,
  modelSaving,
  modelSaveSuccess,
  onModelFieldChange,
  localEmbeddings,
  onToggleLocalEmbeddings,
  showCloudControls,
  elizaCloudConnected,
}: ProviderRoutingPanelProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=ProviderRoutingPanel.d.ts.map
