/**
 * AGENT PROVISIONING home widget. Surfaces the shared→dedicated cloud-agent
 * handoff on the home grid: while a freshly-provisioned cloud agent's dedicated
 * container boots, the user is already chatting on the shared REST adapter and
 * this naked tile shows the background provisioning ("Setting up…") plus a Retry
 * control if the boot times out / fails. Once the dedicated agent is bound it
 * self-hides — a pure-local or fully-provisioned user never sees this tile.
 *
 * No new state seam: it consumes the SAME `useCloudHandoffPhase()` event that
 * the in-chat boot-recovery conductor reads, so the two stay in sync. The
 * conductor's card lives in the chat transcript; this widget is the durable
 * home-grid surface. The optional status poll is best-effort, bounded by
 * withTimeout, and only enriches the "migrating" copy — it never gates the
 * tile.
 */

import { CloudCog } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { client } from "../../../api";
import { isDirectCloudSharedAgentBase } from "../../../api/client-cloud";
import { openCloudBillingConsole } from "../../../cloud/billing-console";
import { loadPendingCloudHandoff } from "../../../cloud/handoff/pending-handoff-store";
import {
  type CloudHandoffPhaseDetail,
  dispatchCloudHandoffRetry,
} from "../../../events";
import { useCloudHandoffPhase } from "../../../hooks/useCloudHandoffPhase";
import { loadPersistedActiveServer } from "../../../state/persistence";
import { withTimeout } from "../../../utils/with-timeout";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const DEFAULT_SPAN = "col-span-2 row-span-1";
const STATUS_POLL_TIMEOUT_MS = 4000;

/**
 * The agent the widget is tracking, resolved at mount from the persisted active
 * server: only a cloud target still on the SHARED adapter base (dedicated not
 * yet attached) is relevant. A fresh handoff phase event can also supply the
 * agentId before the server flips, so the live phase wins when present.
 */
interface SharedCloudTarget {
  agentId: string;
}

function readSharedCloudTarget(): SharedCloudTarget | null {
  const active = loadPersistedActiveServer();
  if (active?.kind !== "cloud") return null;
  if (!isDirectCloudSharedAgentBase(active.apiBase)) return null;
  // The persisted id is keyed `cloud:<agentId>`; recover the bare agent id.
  const agentId = active.id.startsWith("cloud:")
    ? active.id.slice("cloud:".length)
    : active.id;
  if (!agentId) return null;
  // "Setting up…" is only honest while a shared→dedicated migration is
  // actually pending for THIS agent — the durable signal is the pending-
  // handoff marker (the load TTL-clears expired ones). A shared-adapter
  // session with no marker and no live phase has nothing provisioning (e.g. a
  // reused agent bound via the shared adapter by tier preference, or a marker
  // reconciled away after its target died), and a mismatched leftover marker
  // belongs to some other landing — rendering an eternal tile for either was
  // the #15902 pin. Live phase events still take precedence in the component.
  const pending = loadPendingCloudHandoff();
  if (pending?.sharedAgentId !== agentId) return null;
  return { agentId };
}

/**
 * Best-effort, bounded provisioning status text. CloudCompatAgent.status is a
 * coarse string ("provisioning"/"running"/"failed"), NOT a percentage — so we
 * show readable copy, never a fake bar. Returns null on any error/timeout; the
 * caller falls back to generic "Setting up…" copy.
 */
function statusTextFor(status: string | undefined): string | null {
  if (!status) return null;
  const normalized = status.trim().toLowerCase();
  if (normalized === "provisioning" || normalized === "pending") {
    return "Provisioning…";
  }
  if (normalized === "creating" || normalized === "booting") return "Booting…";
  return null;
}

export function AgentProvisioningWidget(
  props: Partial<WidgetProps>,
): React.JSX.Element | null {
  const spanClassName = props.spanClassName ?? DEFAULT_SPAN;
  const nav = useWidgetNavigation();
  const handoff = useCloudHandoffPhase();

  // Resolved once on mount: is the active runtime a cloud agent still on the
  // shared adapter? (i.e. provisioning relevant). The live handoff phase can
  // also carry the agentId, and wins when present.
  const [mountedTarget, setMountedTarget] = useState<SharedCloudTarget | null>(
    null,
  );
  useEffect(() => {
    setMountedTarget(readSharedCloudTarget());
  }, []);

  const detail: CloudHandoffPhaseDetail | null = handoff;
  const agentId = detail?.agentId ?? mountedTarget?.agentId ?? null;

  // Best-effort status enrichment while migrating: a single bounded poll for the
  // CloudCompatAgent.status string. Never gates the tile — on timeout/error the
  // generic copy is used. Re-runs when the tracked agent changes.
  const [statusText, setStatusText] = useState<string | null>(null);
  const lastPolledAgentRef = useRef<string | null>(null);
  const phase = detail?.phase;
  useEffect(() => {
    if (phase !== "migrating" || !agentId) return;
    if (lastPolledAgentRef.current === agentId) return;
    lastPolledAgentRef.current = agentId;
    let cancelled = false;
    void (async () => {
      try {
        const response = await withTimeout(
          client.getCloudCompatAgent(agentId),
          STATUS_POLL_TIMEOUT_MS,
        );
        if (cancelled) return;
        if (response.success)
          setStatusText(statusTextFor(response.data.status));
      } catch {
        // error-policy:J4 bounded status poll is an enhancement over the
        // generic "Setting up…" copy; a hung/errored poll degrades to that
        // designed copy rather than blocking the provisioning tile.
        if (!cancelled) setStatusText(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, agentId]);

  // SELF-HIDE: nothing to track (not a cloud-shared runtime and no live phase),
  // or no agent id known.
  if (!agentId) return null;

  // SELF-HIDE: the dedicated agent is bound. Either the handoff reported a
  // success terminal (and useCloudHandoffPhase has not yet cleared it / it
  // lingers) or the active server already flipped off the shared base. In both
  // cases there is nothing to provision — render nothing.
  if (phase === "switched" || phase === "switched-empty") return null;
  // No live handoff phase AND the active server is no longer on the shared base
  // means the dedicated agent already attached before this widget mounted.
  if (detail == null && mountedTarget == null) return null;

  // Credit gate (402): keep the user on the free shared agent but surface a
  // first-class "add credits for a dedicated agent" tile — not a silent
  // permanent shared fallback (nubs's 0-credit guidance).
  if (phase === "insufficient-credits") {
    return (
      <div className={spanClassName}>
        <HomeWidgetCard
          icon={<CloudCog />}
          label="Cloud agent"
          value="On free shared agent"
          tone="warn"
          badge="Add credits"
          testId="chat-widget-agent-provisioning"
          ariaLabel="You're on the free shared agent. Add credits to get your own dedicated agent."
          onActivate={() => {
            void openCloudBillingConsole();
          }}
        />
      </div>
    );
  }

  const isFailure = phase === "timed-out" || phase === "failed";

  if (isFailure) {
    return (
      <div className={spanClassName}>
        <HomeWidgetCard
          icon={<CloudCog />}
          label="Cloud agent"
          value="Setup paused"
          tone="warn"
          badge="Retry"
          testId="chat-widget-agent-provisioning"
          ariaLabel="Cloud agent setup paused — you're still on the shared agent. Retry setup."
          onActivate={() => dispatchCloudHandoffRetry({ agentId })}
        />
      </div>
    );
  }

  // Provisioning / migrating (the default while the dedicated container boots).
  // The user can already chat on the shared agent, so tapping opens chat.
  const value = statusText ?? "Setting up…";
  return (
    <div className={spanClassName}>
      <HomeWidgetCard
        icon={<CloudCog />}
        label="Cloud agent"
        value={value}
        meta="shared"
        testId="chat-widget-agent-provisioning"
        ariaLabel={`Cloud agent: ${value} — you can chat on the shared agent now. Open chat.`}
        onActivate={() => nav.openTab("chat")}
      />
    </div>
  );
}

export const AGENT_PROVISIONING_HOME_WIDGET = {
  pluginId: "cloud-agent",
  id: "cloud-agent.provisioning",
  order: 60,
  signalKinds: ["activity"],
  Component: AgentProvisioningWidget,
} as const;
