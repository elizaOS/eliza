/**
 * Mounts the singular ChatOverlay from the shared shell controller — the app's
 * one active conversation, floating over every view. The main window (App
 * shell) renders `ChatOverlayMount` directly; each detached desktop view window
 * renders `DockedChatOverlay`, which adds the ShellControllerProvider those
 * windows lack. Both go through the SAME element so the chat follows focus into
 * whichever Eliza window is active (#16200 Stage 3) instead of being a second,
 * different surface per window.
 *
 * Renders null until a controller provider is present, and — on the desktop
 * shell — only while THIS window is the active chat host (the focused Eliza
 * window, or the floating-pill main window when none is focused). Web/mobile
 * and first-run onboarding always render.
 */
import type { ReactNode } from "react";
import { useSlashCommandController } from "../../chat/useSlashCommandController";
import { useRole } from "../../hooks/useRole";
import { useAppSelectorShallow } from "../../state/app-store";
import { useIsChatHostWindow } from "../../state/useDesktopChatHost";
import { ChatOverlay } from "./ChatOverlay";
import { ShellControllerProvider } from "./ShellControllerContext";
import { useShellControllerContext } from "./ShellControllerContext.hooks";

export function ChatOverlayMount({
  onWindowSizingChange,
  restAtPill = false,
}: {
  /** Desktop bottom-bar window only: relocates the OS window between the pill
   *  footprint and the full work area as the overlay opens/collapses. */
  onWindowSizingChange?: (tier: "pill" | "open") => void;
  /** Desktop bottom-bar window only: rest as the collapsed pill, not the input
   *  bar, so the ambient overlay is the least-intrusive floating pill. */
  restAtPill?: boolean;
} = {}): ReactNode {
  const controller = useShellControllerContext();
  const { characterData, agentStatus, firstRunComplete } =
    useAppSelectorShallow((s) => ({
      characterData: s.characterData,
      agentStatus: s.agentStatus,
      firstRunComplete: s.firstRunComplete,
    }));
  // #12087 Item 20: derive the slash-command authority from the authoritative
  // role instead of the fail-open defaults. Elevated (owner-only) commands
  // require OWNER; authenticated commands require rank ≥ USER. A remote
  // USER/GUEST no longer sees elevated commands.
  const { isOwner, atLeast } = useRole();
  const slash = useSlashCommandController({
    isElevated: isOwner,
    isAuthorized: atLeast("USER"),
  });
  // Desktop "one chat, in the active window" gate (#16200 Stage 3): this window
  // renders the chat only when the shell says it is the active host — the
  // focused Eliza window, or the main floating-pill window when none is focused.
  // Always `true` off the desktop shell (web/mobile) and during onboarding (the
  // first-run conductor lives inside this overlay and must never be hidden by a
  // focus change).
  const isChatHost = useIsChatHostWindow();
  if (!controller) return null;
  if (!isChatHost && firstRunComplete !== false) return null;
  // The live agent's name drives the composer placeholder ("Ask {name}").
  // Character name wins (what the user configured), then the running agent's
  // reported name; "Eliza" is the default the overlay falls back to.
  const agentName =
    characterData?.name?.trim() || agentStatus?.agentName?.trim() || undefined;
  return (
    <ChatOverlay
      controller={controller}
      agentName={agentName}
      slash={slash}
      firstRunOpen={firstRunComplete === false}
      onWindowSizingChange={onWindowSizingChange}
      restAtPill={restAtPill}
    />
  );
}

/**
 * Detached desktop view window variant (documents/character/…). Detached
 * windows render outside the App shell's ShellControllerProvider, so this
 * provides its own — every detached window drives the SAME single conversation
 * off the backend, so this is visual relocation, not a second chat. It rests as
 * the pill and passes NO window-sizing callback: a detached window is a normal
 * opaque frame, not the resizable floating-pill OS window, so the overlay just
 * floats at the bottom of the view. The host gate inside {@link ChatOverlayMount}
 * keeps it visible only while this window is the focused chat host.
 */
export function DockedChatOverlay(): ReactNode {
  return (
    <ShellControllerProvider>
      <ChatOverlayMount restAtPill />
    </ShellControllerProvider>
  );
}
