/**
 * Self-contained fixture for the connectors-card e2e: mounts the REAL
 * `ConnectorPluginGroups` (plugin-view-connectors.tsx) with one expanded Signal
 * connector. Signal's default mode is `plugin-managed`, whose setup panel is
 * delegated to `connector-account-management:signal:signal` — a different plugin
 * id than the card's own — which is exactly the `setupPanelPluginId !== plugin.id`
 * case (#10705). The real `PluginConfigForm` and `ConnectorSetupPanel` (account
 * list fed by the canned api stub) both render; only the `state`/`api` barrels
 * are stubbed (see connectors-fixture-*-stub.ts). No app server, no network.
 * Paired with run-connectors-e2e.mjs.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import type { PluginInfo } from "../../../api";
import {
  appNameInterpolationVars,
  DEFAULT_BRANDING,
} from "../../../config/branding-base";
import { createTranslator } from "../../../i18n";
import { TranslationCtx } from "../../../state/TranslationContext.hooks";
import { ConnectorPluginGroups } from "../plugin-view-connectors";

// The real English translator — labels render exactly as they do in the app.
const t = createTranslator("en", appNameInterpolationVars(DEFAULT_BRANDING));

const translationValue = {
  t,
  uiLanguage: "en" as const,
  setUiLanguage: () => {},
};

const signal = {
  id: "signal",
  name: "Signal",
  description: "Connect a Signal account for private messaging.",
  enabled: true,
  isActive: true,
  configured: false,
  envKey: null,
  category: "connector",
  source: "bundled",
  parameters: [
    {
      key: "SIGNAL_PHONE_NUMBER",
      type: "string",
      description: "Phone number registered with Signal (E.164 format).",
      required: true,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    {
      key: "SIGNAL_DEVICE_NAME",
      type: "string",
      description: "Device name shown in Signal's linked-devices list.",
      required: false,
      sensitive: false,
      currentValue: "Eliza",
      isSet: true,
    },
  ],
  validationErrors: [],
  validationWarnings: [],
} as unknown as PluginInfo;

function noopAsync(): Promise<void> {
  return Promise.resolve();
}

function Fixture() {
  return (
    <TranslationCtx.Provider value={translationValue}>
      <FixtureBody />
    </TranslationCtx.Provider>
  );
}

function FixtureBody() {
  return (
    <div className="mx-auto w-full max-w-3xl p-6" data-testid="fixture-root">
      <h1 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted">
        Connectors — Signal (plugin-managed mode, delegated setup panel)
      </h1>
      <ConnectorPluginGroups
        collapseLabel="Collapse"
        connectorExpandedIds={new Set(["signal"])}
        connectorInstallPrompt="Install this connector to get started."
        connectorSelectedId={null}
        expandLabel="Expand"
        formatSaveSettingsLabel={(isSaving: boolean) =>
          isSaving ? "Saving..." : "Save settings"
        }
        formatTestConnectionLabel={() => "Test connection"}
        handleConfigReset={() => {}}
        handleConfigSave={noopAsync}
        handleConnectorExpandedChange={() => {}}
        handleConnectorSectionToggle={() => {}}
        handleInstallPlugin={noopAsync}
        handleOpenPluginExternalUrl={noopAsync}
        handleParamChange={() => {}}
        handleTestConnection={noopAsync}
        handleTogglePlugin={noopAsync}
        hasPluginToggleInFlight={false}
        installPluginLabel="Install"
        installProgress={new Map()}
        installProgressLabel={() => "Installing..."}
        installingPlugins={new Set()}
        loadFailedLabel="Load failed"
        needsSetupLabel="Needs setup"
        noConfigurationNeededLabel="No configuration needed"
        notInstalledLabel="Not installed"
        pluginConfigs={{}}
        pluginDescriptionFallback="Connector plugin"
        pluginSaveSuccess={new Set()}
        pluginSaving={new Set()}
        readyLabel="Ready"
        registerConnectorContentItem={() => () => {}}
        renderResolvedIcon={() => null}
        t={t}
        testResults={new Map()}
        togglingPlugins={new Set()}
        visiblePlugins={[signal]}
      />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("fixture: #root missing");
createRoot(rootEl).render(<Fixture />);
