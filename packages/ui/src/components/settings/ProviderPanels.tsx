import type {
  LinkedAccountProviderId,
  ModelOption,
  SubscriptionProviderStatus,
} from "@elizaos/shared";
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
import { ApiKeyConfig } from "./ApiKeyConfig";
import type { CloudModelSchema } from "./cloud-model-schema";
import { ProviderRoutingPanel } from "./ProviderRoutingPanel";
import { SubscriptionStatus } from "./SubscriptionStatus";
import { SettingsActionButton } from "./settings-agent-rows";

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
      className="flex min-h-[3.25rem] flex-wrap items-center justify-between gap-2 border-border border-b px-4 py-3"
      title={description}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface text-txt-strong ring-1 ring-border/70">
          <Icon className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium leading-5 text-txt-strong">
            {title}
          </h3>
          {description ? (
            <p className="truncate text-xs leading-relaxed text-muted">
              {description}
            </p>
          ) : null}
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
  const { t } = useApp();
  return (
    <div className="min-w-0">
      <ProviderPanelHeader
        icon={Cpu}
        title={t("providerpanels.localProvider", {
          defaultValue: "Local provider",
        })}
        description={t("providerpanels.localProviderDesc", {
          defaultValue:
            "Local downloads, active models, routing, and device pairing.",
        })}
      >
        <SettingsActionButton
          agentId="local-use-local-only"
          agentStatus={cloudCallsDisabled ? "active" : undefined}
          type="button"
          variant={cloudCallsDisabled ? "default" : "outline"}
          className="h-9 rounded-md px-3 text-xs font-medium"
          disabled={routingModeSaving}
          aria-label={
            cloudCallsDisabled
              ? t("providerpanels.localOnlyActive", {
                  defaultValue: "Local only active",
                })
              : t("providerpanels.useLocalOnly", {
                  defaultValue: "Use local only",
                })
          }
          onClick={onSelectLocalOnly}
        >
          <ShieldCheck className="h-4 w-4" aria-hidden />
          {t("providerpanels.localOnly", { defaultValue: "Local only" })}
        </SettingsActionButton>
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
}: CloudPanelProps) {
  const { t } = useApp();
  const cloudActive = !cloudCallsDisabled && isCloudSelected;
  return (
    <div className="min-w-0">
      <ProviderPanelHeader
        icon={Cloud}
        title="Eliza Cloud"
        description={t("providerpanels.cloudDesc", {
          defaultValue: "Managed models, cloud routing, and account credits.",
        })}
      >
        <SettingsActionButton
          agentId="cloud-use-cloud"
          agentStatus={cloudActive ? "active" : undefined}
          type="button"
          variant={cloudActive ? "default" : "outline"}
          className="h-9 rounded-md px-3 text-xs font-medium"
          disabled={routingModeSaving}
          aria-label={
            cloudActive
              ? t("providerpanels.cloudActive", {
                  defaultValue: "Cloud active",
                })
              : t("providerpanels.useCloud", {
                  defaultValue: "Use Eliza Cloud",
                })
          }
          onClick={onSelectCloud}
        >
          <Cloud className="h-4 w-4" aria-hidden />
          {t("providerpanels.cloud", { defaultValue: "Cloud" })}
        </SettingsActionButton>
      </ProviderPanelHeader>
      {/*
       * The buried account + billing dashboard that used to live here moved to
       * the dedicated Settings → Cloud sections (Account & Profile, Billing &
       * Credits). The AI Model panel keeps only the cloud routing toggle (above)
       * and the model routing controls (below).
       */}
      <ProviderRoutingPanel
        largeModelOptions={largeModelOptions}
        cloudModelSchema={cloudModelSchema}
        modelValues={modelValues}
        currentLargeModel={currentLargeModel}
        modelSaving={modelSaving}
        modelSaveSuccess={modelSaveSuccess}
        onModelFieldChange={onModelFieldChange}
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
          <SettingsActionButton
            agentId={`sub-use-${selection.id}`}
            type="button"
            variant="outline"
            className="h-9 rounded-md px-3 text-xs font-medium"
            onClick={() => void onSelectSubscription(selection.id)}
          >
            {t("providerpanels.useSubscription", {
              defaultValue: "Use subscription",
            })}
          </SettingsActionButton>
        ) : null}
      </ProviderPanelHeader>
      <div className="px-3 py-3 sm:px-4">
        {cloudCallsDisabled ? (
          <div className="mb-3 rounded-sm border border-warn/30 bg-warn/5 px-3 py-2 text-warn text-xs">
            {t("providerpanels.localOnlySubscriptionPaused", {
              defaultValue: "Local-only active — remote routing is paused.",
            })}
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
  const { t } = useApp();
  const showUseButton =
    cloudCallsDisabled || resolvedSelectedId !== visibleProviderPanelId;
  return (
    <div className="min-w-0">
      <ProviderPanelHeader
        icon={KeyRound}
        title={panelLabel}
        description={t("providerpanels.apiKeyDesc", {
          defaultValue: "Your provider API key and model routing.",
        })}
      >
        {showUseButton ? (
          <SettingsActionButton
            agentId={`apikey-use-${visibleProviderPanelId}`}
            type="button"
            variant="outline"
            className="h-9 rounded-md px-3 text-xs font-medium"
            onClick={() => onSwitchProvider(visibleProviderPanelId)}
          >
            {t("providerpanels.useProvider", { defaultValue: "Use provider" })}
          </SettingsActionButton>
        ) : null}
      </ProviderPanelHeader>
      <div className="px-3 py-3 sm:px-4">
        {cloudCallsDisabled ? (
          <div className="mb-3 rounded-sm border border-warn/30 bg-warn/5 px-3 py-2 text-warn text-xs">
            {t("providerpanels.localOnlyApiPaused", {
              defaultValue: "Local-only active — remote routing is paused.",
            })}
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
