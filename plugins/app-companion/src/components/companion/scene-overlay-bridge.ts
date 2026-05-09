import { useApp } from "@elizaos/ui";
import { usePtySessions } from "@elizaos/ui";
import { useCallback, useEffect, useRef } from "react";
import type { SceneOverlayManager } from "../avatar/SceneOverlayManager";
import type {
  AgentStatusOverlay,
  ChatOverlayMessage,
  TriggerOverlay,
} from "../avatar/scene-overlay-renderer";
import type { VrmEngine } from "../avatar/VrmEngine";

/** Find the overlay manager from the VRM engine debug registry. */
function findOverlayManager(): SceneOverlayManager | null {
  const registry = (
    window as {
      __ELIZA_VRM_ENGINES__?: Array<{ engine: VrmEngine }>;
    }
  ).__ELIZA_VRM_ENGINES__;
  if (!registry) return null;
  for (const entry of registry) {
    const overlay = entry.engine.getOverlayManager();
    if (overlay) return overlay;
  }
  return null;
}

/**
 * Leaf component that subscribes to app state and pushes data into the
 * overlay manager. Render this at the app level, outside CompanionSceneHost.
 */
export function SceneOverlayDataBridge(): null {
  const { conversationMessages, agentStatus, triggers } = useApp();
  const { ptySessions } = usePtySessions();
  const managerRef = useRef<SceneOverlayManager | null>(null);

  // Lazily resolve the overlay manager on each effect run
  const getManager = useCallback((): SceneOverlayManager | null => {
    if (managerRef.current) return managerRef.current;
    managerRef.current = findOverlayManager();
    return managerRef.current;
  }, []);

  // Chat messages
  useEffect(() => {
    const manager = getManager();
    if (!manager) return;

    const mapped: ChatOverlayMessage[] = conversationMessages
      .slice(-12)
      .map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
      }));
    manager.setChatMessages(mapped);
  }, [conversationMessages, getManager]);

  // Agent status + coding sessions
  useEffect(() => {
    const manager = getManager();
    if (!manager) return;

    if (!agentStatus) {
      manager.setAgentStatus(null);
      return;
    }

    const status: AgentStatusOverlay = {
      state: agentStatus.state,
      agentName: agentStatus.agentName,
      uptime: agentStatus.uptime,
      sessions: (ptySessions ?? []).map((s) => ({
        sessionId: s.sessionId,
        label: s.label,
        agentType: s.agentType,
      })),
    };
    manager.setAgentStatus(status);
  }, [agentStatus, ptySessions, getManager]);

  // Heartbeats / triggers
  useEffect(() => {
    const manager = getManager();
    if (!manager) return;

    const mapped: TriggerOverlay[] = triggers.map((t) => ({
      id: t.id,
      displayName: t.displayName,
      triggerType: t.triggerType,
      enabled: t.enabled,
      lastStatus: t.lastStatus,
      cronExpression: t.cronExpression,
      intervalMs: t.intervalMs,
    }));
    manager.setHeartbeats(mapped);
  }, [triggers, getManager]);

  return null;
}
