/**
 * Provider-specific bodies for local inference, cloud routing, coding
 * subscriptions, and API keys. The parent owns selection state while each
 * panel exposes an agent-addressable activation control. An unsigned-in
 * Cloud panel signs the user in rather than pretending the route is live.
 */

import type { ModelOption } from "@elizaos/shared";
import { Cloud, Cpu, KeyRound, LogIn, ShieldCheck } from "lucide-react";
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
        <Icon className="size-[18px] shrink-0 text-muted/80" aria-hidden />
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
  servingFallback = false,
}: {
  cloudCallsDisabled: boolean;
  routingModeSaving: boolean;
  onSelectLocalOnly: () => void;
  /** Cloud is configured but unsigned-in, so Local is answering chat. */
  servingFallback?: boolean;
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
          <ShieldCheck className="size-4" aria-hidden />
          {t("providerpanels.localOnly", { defaultValue: "Local only" })}
        </SettingsActionButton>
      </ProviderPanelHeader>
      <div className="p-3 sm:px-4">
        {servingFallback ? (
          <div className="mb-3 rounded-sm border border-warn/30 bg-warn/5 px-3 py-2 text-warn text-xs">
            {t("providerpanels.localFallbackBecauseCloudUnsigned", {
              defaultValue:
                "Answering chat because Eliza Cloud isn't signed in.",
            })}
          </div>
        ) : null}
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
  /** Opens the interactive Cloud login when the account is unsigned-in. */
  onSignIn: () => void;
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
  onSignIn,
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
  const cloudActive =
    !cloudCallsDisabled && isCloudSelected && elizaCloudConnected;
  const needsSignIn = !elizaCloudConnected;
  return (
    <div className="min-w-0">
      <ProviderPanelHeader icon={Cloud} title="Eliza Cloud">
        <SettingsActionButton
          agentId={needsSignIn ? "cloud-sign-in" : "cloud-use-cloud"}
          agentStatus={cloudActive ? "active" : undefined}
          agentLabel={
            needsSignIn
              ? t("providerpanels.signInToCloud", {
                  defaultValue: "Sign in to Eliza Cloud",
                })
              : cloudActive
                ? t("providerpanels.cloudActive", {
                    defaultValue: "Cloud active",
                  })
                : t("providerpanels.useCloud", {
                    defaultValue: "Use Eliza Cloud",
                  })
          }
          type="button"
          variant={cloudActive || needsSignIn ? "default" : "outline"}
          className="h-9 rounded-md px-3 text-xs font-medium"
          disabled={routingModeSaving}
          aria-label={
            needsSignIn
              ? t("providerpanels.signInToCloud", {
                  defaultValue: "Sign in to Eliza Cloud",
                })
              : cloudActive
                ? t("providerpanels.cloudActive", {
                    defaultValue: "Cloud active",
                  })
                : t("providerpanels.useCloud", {
                    defaultValue: "Use Eliza Cloud",
                  })
          }
          onClick={needsSignIn ? onSignIn : onSelectCloud}
        >
          {needsSignIn ? (
            <LogIn className="size-4" aria-hidden />
          ) : (
            <Cloud className="size-4" aria-hidden />
          )}
          {needsSignIn
            ? t("providerpanels.signIn", { defaultValue: "Sign in" })
            : t("providerpanels.cloud", { defaultValue: "Cloud" })}
        </SettingsActionButton>
      </ProviderPanelHeader>
      {needsSignIn ? (
        <div className="p-3 sm:px-4">
          <div className="rounded-sm border border-warn/30 bg-warn/5 px-3 py-2 text-warn text-xs">
            {t("providerpanels.cloudUnsignedUsingLocal", {
              defaultValue:
                "Eliza Cloud isn't signed in. Chat replies are using Local.",
            })}
          </div>
        </div>
      ) : (
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
      )}
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
      <div className="p-3 sm:px-4">
        {cloudCallsDisabled ? (
          <div className="mb-3 rounded-sm border border-warn/30 bg-warn/5 px-3 py-2 text-warn text-xs">
            {t("providerpanels.localOnlySubscriptionPaused", {
              defaultValue: "Local only is active. Remote routing is paused.",
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
      <div className="p-3 sm:px-4">
        {cloudCallsDisabled ? (
          <div className="mb-3 rounded-sm border border-warn/30 bg-warn/5 px-3 py-2 text-warn text-xs">
            {t("providerpanels.localOnlyApiPaused", {
              defaultValue: "Local only is active. Remote routing is paused.",
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
      </div>
    </div>
  );
}
