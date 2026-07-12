/**
 * Chat surface for the Design Lab: mounts the REAL ChatOverlay over a
 * fake workspace backdrop with a live mock controller, and portals a control
 * panel (transcript seed, phase, voice state, plus imperative send/append/stream
 * actions) into the lab's controls column. The same component powers the
 * "Onboarding" entry with `onboarding` set — it pins the sheet first-run and
 * swaps the transcript for the greeting turn, with a Complete-onboarding action
 * that drives the falling-edge reveal a static prop can't reach.
 */

import { ChatOverlay } from "@ui-src/components/shell/ChatOverlay";
import type { ShellController } from "@ui-src/components/shell/useShellController";

import { GlassStyles } from "@ui-src/glass";
import * as React from "react";
import { createPortal } from "react-dom";
import {
  ActionButton,
  ControlGroup,
  Hint,
  Row,
  Segmented,
  Toggle,
} from "../lab-ui";
import {
  type ChatSeedKind,
  type MockChatConfig,
  useMockChat,
} from "../mock-chat";

const SEEDS: { value: ChatSeedKind; label: string }[] = [
  { value: "conversation", label: "Conversation" },
  { value: "long", label: "Long (scrolls)" },
  { value: "empty", label: "Empty" },
];

const PHASES: { value: ShellController["phase"]; label: string }[] = [
  { value: "summoned", label: "Idle" },
  { value: "responding", label: "Responding" },
  { value: "booting", label: "Booting" },
];

// Fire the cloud-handoff phase event the in-chat provisioning card listens for
// (useCloudHandoffPhase). "switched" is the self-hide terminal.
const cloudPhase = (phase: string) =>
  window.dispatchEvent(
    new CustomEvent("eliza:cloud-handoff-phase", {
      detail: { agentId: "lab-cloud-agent", phase },
    }),
  );

export function ChatLab({
  controlsEl,
  onboarding = false,
}: {
  controlsEl: HTMLElement | null;
  onboarding?: boolean;
}) {
  const [seed, setSeed] = React.useState<ChatSeedKind>(
    onboarding ? "first-run" : "conversation",
  );
  const [phase, setPhase] =
    React.useState<ShellController["phase"]>("summoned");
  const [recording, setRecording] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);
  const [speaking, setSpeaking] = React.useState(false);
  const [noProvider, setNoProvider] = React.useState(false);
  const [firstRun, setFirstRun] = React.useState(onboarding);

  const config: MockChatConfig = {
    seed,
    phase,
    recording,
    transcribing,
    speaking,
    noProvider,
  };
  const chat = useMockChat(config);

  const controls = (
    <>
      {onboarding ? (
        <ControlGroup label="Onboarding">
          <Hint>
            The sheet is pinned full-screen and the composer is locked until
            sign-in. Complete it to watch the falling-edge reveal (opaque
            backdrop fades, sheet settles to half).
          </Hint>
          <Row>
            <ActionButton variant="primary" onClick={() => setFirstRun(false)}>
              Complete onboarding →
            </ActionButton>
            <ActionButton onClick={() => setFirstRun(true)}>
              Restart
            </ActionButton>
          </Row>
        </ControlGroup>
      ) : (
        <ControlGroup label="Transcript">
          <Segmented value={seed} options={SEEDS} onChange={setSeed} />
        </ControlGroup>
      )}

      <ControlGroup label="Agent phase">
        <Segmented value={phase} options={PHASES} onChange={setPhase} />
      </ControlGroup>

      <ControlGroup label="Voice / state">
        <Toggle label="Recording" checked={recording} onChange={setRecording} />
        <Toggle
          label="Transcribing"
          checked={transcribing}
          onChange={setTranscribing}
        />
        <Toggle label="Speaking" checked={speaking} onChange={setSpeaking} />
        <Toggle
          label="No provider (recovery gate)"
          checked={noProvider}
          onChange={setNoProvider}
        />
      </ControlGroup>

      <ControlGroup label="Cloud provisioning (in-chat)">
        <Hint>
          The dedicated cloud-agent setup status now renders INSIDE the chat,
          above the composer — not as a home widget above it. Fire a handoff
          phase to see it.
        </Hint>
        <Row>
          <ActionButton onClick={() => cloudPhase("migrating")}>
            Provisioning
          </ActionButton>
          <ActionButton onClick={() => cloudPhase("failed")}>
            Failed
          </ActionButton>
        </Row>
        <Row>
          <ActionButton onClick={() => cloudPhase("insufficient-credits")}>
            No credits
          </ActionButton>
          <ActionButton onClick={() => cloudPhase("switched")}>
            Clear
          </ActionButton>
        </Row>
      </ControlGroup>

      <ControlGroup label="Drive the thread">
        <Hint>
          Exercise the drag / scroll behaviours by hand — no agent needed.
        </Hint>
        <Row>
          <ActionButton onClick={() => chat.sendUser("Try the maximize drag")}>
            Send a message
          </ActionButton>
          <ActionButton onClick={() => chat.appendAssistant()}>
            New reply
          </ActionButton>
        </Row>
        <Row>
          <ActionButton onClick={() => chat.streamReply()}>
            Stream a reply
          </ActionButton>
          <ActionButton onClick={() => chat.reset()}>Reset</ActionButton>
        </Row>
      </ControlGroup>
    </>
  );

  return (
    <>
      {/* Fake workspace backdrop so the glass + dimming read over a real
          surface and a click-out target exists. */}
      <div className="lab-fakeview">
        <h1>Workspace</h1>
        <p>
          The live view behind the floating chat. Clicking here must NOT close
          the chat — it only closes on a pull-down or Escape.
        </p>
        <div className="lab-fakeview-chips">
          {["Files", "Tasks", "Notes", "Settings"].map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </div>
      <GlassStyles />
      <ChatOverlay
        controller={chat.controller}
        firstRunOpen={firstRun}
      />
      {controlsEl ? createPortal(controls, controlsEl) : null}
    </>
  );
}
