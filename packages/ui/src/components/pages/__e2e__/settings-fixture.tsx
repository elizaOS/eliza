/**
 * Self-contained Settings browser fixture over the real section registry.
 * State, API, and core boundaries are stubbed, while production providers and
 * section components stay mounted so navigation and visible failure states are
 * exercised by the walkthrough.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import type { AccountsListProvider } from "../../../api/client-agent";
import { TranslationProvider } from "../../../state/TranslationProvider";
import { getAccountProviderOption } from "../../accounts/account-provider-options";
import { ProviderAccountRow } from "../../accounts/ProviderAccountRow";
import { SettingsView } from "../SettingsView";

const accountProvider: AccountsListProvider = {
  providerId: "openai-codex",
  strategy: "priority",
  accounts: [{
    id: "fixture-codex",
    providerId: "openai-codex",
    label: "Personal subscription",
    source: "oauth",
    enabled: true,
    priority: 1,
    createdAt: 0,
    health: "ok",
    hasCredential: true,
  }],
};

function AccountRowFixture(): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const [action, setAction] = React.useState("");
  const option = getAccountProviderOption("openai-codex");
  if (!option) throw new Error("Codex provider option unavailable");
  const noMutation = async () => {};
  return (
    <div className="grid w-full gap-3 p-6 sm:pl-[264px]">
      <ProviderAccountRow
        option={option}
        provider={accountProvider}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        onSelectSubscription={() => setAction("coding selected")}
        onAdd={() => setAction("add account")}
        saving={new Set<string>()}
        onPatch={noMutation}
        onMove={noMutation}
        onTest={noMutation}
        onRefreshUsage={noMutation}
        onDelete={noMutation}
        onStrategyChange={() => {}}
      />
      <output>{action}</output>
    </div>
  );
}

function Harness(): React.JSX.Element {
  return (
    <TranslationProvider>
      <div className="min-h-dvh w-full bg-bg text-txt">
        {new URLSearchParams(location.search).has("account-row")
          ? <AccountRowFixture />
          : <SettingsView />}
      </div>
    </TranslationProvider>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
