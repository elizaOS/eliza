import { useRenderGuard } from "@elizaos/ui/hooks";
import { type CSSProperties, memo } from "react";
import { AGENT_EMOTE_CATALOG, EMOTE_CATALOG } from "../../emotes/catalog";
import { CompanionSceneHost } from "./CompanionSceneHost";
import { countByCategory } from "./CompanionView.helpers";
import { useCompanionSceneStatus } from "./companion-scene-status-context";
import { EmotePicker } from "./EmotePicker";

/**
 * Inner overlay rendered on top of the avatar scene. The companion now shows
 * just the avatar — no header / nav bar — so this only hosts the emote picker
 * overlay. Chat/voice happen in the global floating pill that floats over every
 * view; character + settings live in the main app's own tabs.
 */
const CompanionViewOverlay = memo(function CompanionViewOverlay() {
  useRenderGuard("CompanionView");
  const emoteCategories = countByCategory();
  const categoryCount = Object.keys(emoteCategories).length;
  const { avatarReady } = useCompanionSceneStatus();

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        pointerEvents: "none",
      }}
    >
      <EmotePicker />

      {/* Status metadata remains in the DOM for agent/a11y inspection without
          adding visible chrome over the avatar stage. */}
      <div
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clipPath: "inset(50%)",
          display: "flex",
        }}
        title="Companion avatar surface"
      >
        <StatusChip ready={avatarReady} />
        <CompanionChip
          label={`${AGENT_EMOTE_CATALOG.length} emotes`}
          title="Agent emotes"
        />
        <CompanionChip
          label={`${EMOTE_CATALOG.length}/${categoryCount} catalog`}
          title="Emote catalog"
        />
        <CompanionChip label="overlay relay" title="Global chat relay" subtle />
      </div>

      <div style={{ minHeight: 0, flex: 1 }} />
    </div>
  );
});

const CHIP_BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  minHeight: 28,
  padding: "0 1px",
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1,
  whiteSpace: "nowrap",
};

function StatusChip({ ready }: { ready: boolean }) {
  return (
    <span
      style={{
        ...CHIP_BASE,
        background: ready ? "var(--status-success-bg)" : "var(--accent-subtle)",
        color: ready ? "var(--status-success)" : "var(--accent)",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          flexShrink: 0,
          borderRadius: "50%",
          background: ready ? "var(--status-success)" : "var(--accent)",
          boxShadow: ready
            ? "0 0 0 3px var(--status-success-bg)"
            : "0 0 0 3px var(--accent-subtle)",
          animation: ready
            ? undefined
            : "companion-chip-pulse 1.4s ease-in-out infinite",
        }}
      />
      <span>{ready ? "ready" : "loading"}</span>
      <style>{`@keyframes companion-chip-pulse{0%,100%{opacity:1}50%{opacity:0.35}}`}</style>
    </span>
  );
}

function CompanionChip({
  label,
  title,
  subtle = false,
}: {
  label: string;
  title: string;
  subtle?: boolean;
}) {
  return (
    <span
      style={{
        ...CHIP_BASE,
        background: "var(--surface)",
        color: subtle ? "var(--muted)" : "var(--text-strong)",
      }}
      title={title}
    >
      {label}
    </span>
  );
}

/**
 * CompanionView — thin shell that composes CompanionSceneHost + overlay.
 * Does NOT subscribe to useApp() so CompanionSceneHost receives stable
 * children and avoids re-rendering the 3D scene on unrelated state changes.
 */
export const CompanionView = memo(function CompanionView() {
  return (
    <CompanionSceneHost active>
      <CompanionViewOverlay />
    </CompanionSceneHost>
  );
});
