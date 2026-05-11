import type {
  LinkedAccountProviderId,
  ModelOption,
  SubscriptionProviderStatus,
} from "@elizaos/shared";
import { Button } from "@elizaos/ui";
import { Cloud, Cpu, KeyRound, ShieldCheck } from "lucide-react";
import type { ComponentType, Dispatch, ReactNode, SetStateAction } from "react";
import type { PluginParamDef } from "../../api";
import type {
  SUBSCRIPTION_PROVIDER_SELECTIONS,
  SubscriptionProviderSelectionId,
} from "../../providers";
import { useApp } from "../../state";
import type { ConfigUiHint } from "../../types";
import { AccountList } from "../accounts/AccountList";
import { LocalInferencePanel } from "../local-inference/LocalInferencePanel";
import { CloudDashboard } from "../pages/ElizaCloudDashboard";
import { ApiKeyConfig } from "./ApiKeyConfig";
import type { CloudModelSchema } from "./cloud-model-schema";
import { ProviderRoutingPanel } from "./ProviderRoutingPanel";
import { SubscriptionStatus } from "./SubscriptionStatus";

type SubscriptionProviderSelection =
  (typeof SUBSCRIPTION_PROVIDER_SELECTIONS)[number];

interface PluginInfo {
  id: string;
  name: string;
  category: string;
  enabled: boolean;
  configured: boolean;
  parameters: PluginParamDef[];
  configUiHints?: Record<string, ConfigUiHint>;
}

function ProviderPanelHeader({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header
      className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-border/40 border-b px-3 py-2 sm:px-4"
      title={description}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-bg/50 text-muted">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-sm text-txt">{title}</h3>
        </div>
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </header>
  );
}

export function LocalProviderPanel({
  cloudCallsDisabled,
  routingModeSaving,
  onSelectLocalOnly,
}: {
  cloudCallsDisabled: boolean;
  routingModeSaving: boolean;
  onSelectLocalOnly: () => void;
}) {
  return (
    <div className="min-w-0">
      <ProviderPanelHeader
        icon={Cpu}
        title="Local provider"
        description="Manage local downloads, active models, routing, and device pairing in one place."
      >
        <Button
          type="button"
          variant={cloudCallsDisabled ? "default" : "outline"}
          className="h-8 rounded-lg px-2.5 text-xs"
          disabled={routingModeSaving}
          aria-label={
            cloudCallsDisabled ? "Local only active" : "Use local only"
          }
          onClick={onSelectLocalOnly}
        >
          <ShieldCheck className="h-4 w-4" aria-hidden />
          Local only
        </Button>
      </ProviderPanelHeader>
      <div className="px-3 py-3 sm:px-4">
        <LocalInferencePanel />
      </div>
    </div>
  );
}

export interface CloudPanelProps {
  cloudCallsDisabled: boolean;
  isCloudSelected: boolean;
  routingModeSaving: boolean;
  onSelectCloud: () => void;
  elizaCloudConnected: boolean;
  largeModelOptions: ModelOption[];
  cloudModelSchema: CloudModelSchema | null;
  modelValues: { values: Record<string, unknown>; setKeys: Set<string> };
  currentLargeModel: string;
  modelSaving: boolean;
  modelSaveSuccess: boolean;
  onModelFieldChange: (key: string, value: unknown) => void;
  localEmbeddings: boolean;
  onToggleLocalEmbeddings: (next: boolean) => void;
}

export function CloudPanel({
  cloudCallsDisabled,
  isCloudSelected,
  routingModeSaving,
  onSelectCloud,
  elizaCloudConnected,
  largeModelOptions,
  cloudModelSchema,
  modelValues,
  currentLargeModel,
  modelSaving,
  modelSaveSuccess,
  onModelFieldChange,
  localEmbeddings,
  onToggleLocalEmbeddings,
}: CloudPanelProps) {
  const cloudActive = !cloudCallsDisabled && isCloudSelected;
  return (
    <div className="min-w-0">
      <ProviderPanelHeader
        icon={Cloud}
        title="Eliza Cloud"
        description="Use managed models, cloud routing, and account credits."
      >
        <Button
          type="button"
          variant={cloudActive ? "default" : "outline"}
          className="h-8 rounded-lg px-2.5 text-xs"
          disabled={routingModeSaving}
          aria-label={cloudActive ? "Cloud active" : "Use Eliza Cloud"}
          onClick={onSelectCloud}
        >
          <Cloud className="h-4 w-4" aria-hidden />
          Cloud
        </Button>
      </ProviderPanelHeader>
      <CloudDashboard />
      <ProviderRoutingPanel
        largeModelOptions={largeModelOptions}
        cloudModelSchema={cloudModelSchema}
        modelValues={modelValues}
        currentLargeModel={currentLargeModel}
        modelSaving={modelSaving}
        modelSaveSuccess={modelSaveSuccess}
        onModelFieldChange={onModelFieldChange}
        localEmbeddings={localEmbeddings}
        onToggleLocalEmbeddings={onToggleLocalEmbeddings}
        showCloudControls={cloudActive}
        elizaCloudConnected={elizaCloudConnected}
      />
    </div>
  );
}

export interface SubscriptionPanelProps {
  selection: SubscriptionProviderSelection;
  description: string;
  visibleProviderPanelId: string;
  resolvedSelectedId: string | null;
  cloudCallsDisabled: boolean;
  subscriptionStatus: SubscriptionProviderStatus[];
  anthropicConnected: boolean;
  setAnthropicConnected: Dispatch<SetStateAction<boolean>>;
  anthropicCliDetected: boolean;
  openaiConnected: boolean;
  setOpenaiConnected: Dispatch<SetStateAction<boolean>>;
  onSelectSubscription: (
    providerId: SubscriptionProviderSelectionId,
    activate?: boolean,
  ) => Promise<void>;
  loadSubscriptionStatus: () => Promise<void>;
}

export function SubscriptionPanel({
  selection,
  description,
  visibleProviderPanelId,
  resolvedSelectedId,
  cloudCallsDisabled,
  subscriptionStatus,
  anthropicConnected,
  setAnthropicConnected,
  anthropicCliDetected,
  openaiConnected,
  setOpenaiConnected,
  onSelectSubscription,
  loadSubscriptionStatus,
}: SubscriptionPanelProps) {
  const { t } = useApp();
  const showUseButton =
    cloudCallsDisabled || resolvedSelectedId !== visibleProviderPanelId;
  return (
    <div className="min-w-0">
      <ProviderPanelHeader
        icon={KeyRound}
        title={t(selection.labelKey, { defaultValue: selection.id })}
        description={description}
      >
        {showUseButton ? (
          <Button
            type="button"
            variant="outline"
            className="h-8 rounded-lg px-2.5 text-xs"
            onClick={() => void onSelectSubscription(selection.id)}
          >
            Use subscription
          </Button>
        ) : null}
      </ProviderPanelHeader>
      <div className="px-3 py-3 sm:px-4">
        {cloudCallsDisabled ? (
          <div className="mb-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-warn text-xs-tight">
            Local-only active. Remote subscription routing is paused.
          </div>
        ) : null}
        <SubscriptionStatus
          resolvedSelectedId={visibleProviderPanelId}
          subscriptionStatus={subscriptionStatus}
          anthropicConnected={anthropicConnected}
          setAnthropicConnected={setAnthropicConnected}
          anthropicCliDetected={anthropicCliDetected}
          openaiConnected={openaiConnected}
          setOpenaiConnected={setOpenaiConnected}
          handleSelectSubscription={onSelectSubscription}
          loadSubscriptionStatus={loadSubscriptionStatus}
        />
        <AccountList providerId={selection.storedProvider} />
      </div>
    </div>
  );
}

export interface ApiKeyPanelProps {
  selectedProvider: PluginInfo;
  panelLabel: string;
  visibleProviderPanelId: string;
  resolvedSelectedId: string | null;
  cloudCallsDisabled: boolean;
  selectedPanelAccountProvider: LinkedAccountProviderId | null;
  onSwitchProvider: (id: string) => void;
  pluginSaving: Set<string>;
  pluginSaveSuccess: Set<string>;
  handlePluginConfigSave: (
    pluginId: string,
    values: Record<string, string>,
  ) => void;
  loadPlugins: () => Promise<void>;
}

export function ApiKeyPanel({
  selectedProvider,
  panelLabel,
  visibleProviderPanelId,
  resolvedSelectedId,
  cloudCallsDisabled,
  selectedPanelAccountProvider,
  onSwitchProvider,
  pluginSaving,
  pluginSaveSuccess,
  handlePluginConfigSave,
  loadPlugins,
}: ApiKeyPanelProps) {
  const showUseButton =
    cloudCallsDisabled || resolvedSelectedId !== visibleProviderPanelId;
  return (
    <div className="min-w-0">
      <ProviderPanelHeader
        icon={KeyRound}
        title={panelLabel}
        description="Use your own provider API key and model routing."
      >
        {showUseButton ? (
          <Button
            type="button"
            variant="outline"
            className="h-8 rounded-lg px-2.5 text-xs"
            onClick={() => onSwitchProvider(visibleProviderPanelId)}
          >
            Use provider
          </Button>
        ) : null}
      </ProviderPanelHeader>
      <div className="px-3 py-3 sm:px-4">
        {cloudCallsDisabled ? (
          <div className="mb-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-warn text-xs-tight">
            Local-only active. Remote API routing is paused.
          </div>
        ) : null}
        <ApiKeyConfig
          selectedProvider={selectedProvider}
          pluginSaving={pluginSaving}
          pluginSaveSuccess={pluginSaveSuccess}
          handlePluginConfigSave={handlePluginConfigSave}
          loadPlugins={loadPlugins}
        />
        {selectedPanelAccountProvider ? (
          <AccountList providerId={selectedPanelAccountProvider} />
        ) : null}
      </div>
    </div>
  );
}
