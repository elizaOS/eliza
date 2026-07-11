/**
 * The four per-provider panel bodies rendered by ProviderSwitcher inside the AI
 * Model settings section: Local (on-device inference), Eliza Cloud (routing +
 * model selection), Subscription (Claude/Codex plans), and API-key providers.
 * Each renders a shared header with an agent-addressable "use this" activation
 * button; ProviderSwitcher owns the selection state and passes it in as props.
 */

import type { LinkedAccountProviderId, ModelOption } from "@elizaos/shared";
import { Cloud, Cpu, KeyRound, ShieldCheck } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import type {
  SUBSCRIPTION_PROVIDER_SELECTIONS,
  SubscriptionProviderSelectionId,
} from "../../providers";
import { useAppSelector } from "../../state";
import { AccountList } from "../accounts/AccountList";
import { LocalInferencePanel } from "../local-inference/LocalInferencePanel";
import { ApiKeyConfig } from "./ApiKeyConfig";
import type { CloudModelSchema } from "./cloud-model-schema";
import { ProviderRoutingPanel } from "./ProviderRoutingPanel";
import { SettingsActionButton } from "./settings-agent-rows";
import type { PluginInfo } from "./useProviderEntries";

type SubscriptionProviderSelection =
  (typeof SUBSCRIPTION_PROVIDER_SELECTIONS)[number];

function ProviderPanelHeader({
  icon: Icon,
  title,
  children,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex min-h-[3rem] flex-wrap items-center justify-between gap-2 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <Icon
          className="h-[18px] w-[18px] shrink-0 text-muted/80"
          aria-hidden
        />
        <h3 className="truncate text-sm font-medium leading-5 text-txt-strong">
          {title}
        </h3>
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
  const t = useAppSelector((s) => s.t);
  return (
    <div className="min-w-0">
      <ProviderPanelHeader
        icon={Cpu}
        title={t("providerpanels.localProvider", {
          defaultValue: "Local provider",
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
  const t = useAppSelector((s) => s.t);
  const cloudActive = !cloudCallsDisabled && isCloudSelected;
  return (
    <div className="min-w-0">
      <ProviderPanelHeader icon={Cloud} title="Eliza Cloud">
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
  visibleProviderPanelId: string;
  resolvedSelectedId: string | null;
  cloudCallsDisabled: boolean;
  onSelectSubscription: (
    providerId: SubscriptionProviderSelectionId,
    activate?: boolean,
  ) => Promise<void>;
}

export function SubscriptionPanel({
  selection,
  visibleProviderPanelId,
  resolvedSelectedId,
  cloudCallsDisabled,
  onSelectSubscription,
}: SubscriptionPanelProps) {
  const t = useAppSelector((s) => s.t);
  const showUseButton =
    cloudCallsDisabled || resolvedSelectedId !== visibleProviderPanelId;
  return (
    <div className="min-w-0">
      <ProviderPanelHeader
        icon={KeyRound}
        title={t(selection.labelKey, { defaultValue: selection.id })}
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
        <p className="mb-2 text-xs text-muted">
          Add and manage subscription accounts below. Login state is preserved
          while an external browser or device authorization is active.
        </p>
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
  const t = useAppSelector((s) => s.t);
  const showUseButton =
    cloudCallsDisabled || resolvedSelectedId !== visibleProviderPanelId;
  return (
    <div className="min-w-0">
      <ProviderPanelHeader icon={KeyRound} title={panelLabel}>
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
