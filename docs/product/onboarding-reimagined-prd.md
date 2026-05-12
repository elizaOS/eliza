# Eliza Start and Onboarding Reimagining PRD

Date: 2026-05-12

## Summary

Replace the current pre-chat runtime gate with a calm, voice-first companion start. The first frame is a blue sky, then slow infinite clouds, a reactive avatar, compact conversation history, and a ChatGPT-like composer optimized for text, voice, dictation, and attachments.

The setup path stays simple: choose Cloud, Remote, or Local; choose language; verify speaker and microphone; collect owner facts; land in the companion chat. Desktop should converge on the same companion experience plus a tray runtime and a thin always-available bottom bar.

## Goals

- Remove the white startup flash by setting the app/page background to blue before React mounts.
- Make sky/clouds a replaceable background module that can be edited through a `BACKGROUND_EDIT` agent action.
- Make onboarding feel like the product: an assistant is immediately available, especially during Cloud setup.
- Collapse Cloud onboarding to one agent per user. No cloud agent picker.
- Start Local model download immediately when Local is selected, with hardware and disk warnings before completion.
- Move language selection into onboarding and remove theme selection from onboarding.
- Make voice setup first-class: speaker test, mic permission, input selection, live waveform, retries, and skip paths.
- Make the companion screen the post-onboarding default on mobile and desktop.
- Rename user-facing "Apps" to "Views"; plugins expose generated React views through a `views` array.
- Add avatar customization as a dynamic module with initial presets: waveform shader, Jarvis, and VRM 3D model.
- Enable compact, expandable message history that fades in and expands smoothly on scroll.
- Add desktop tray behavior and a thin Wispr Flow-style bottom bar with global shortcut, push-to-talk, and always-on mic mode.

## Non-Goals

- This PRD does not require changing LifeOps task architecture.
- This PRD does not replace `ScheduledTask` for reminders, follow-ups, recaps, watchers, or approvals.
- This PRD does not decide final model weights or licensing beyond requiring the local flow to use the preferred Eliza-1 model registry.
- This PRD does not silently enable always-on capture. Consent, controls, retention, and delete UX are required.

## Primary Experience

### 1. First Paint and Background

Requirements:

- `html`, `body`, root shell, and startup containers use the same blue background color before assets load.
- The cloud layer loads after the blue paint. The blue background must still look intentional if cloud assets fail.
- The cloud animation is infinite, slow, and seamless. No visual seam should cross the screen.
- Implementation must prefer compositor-friendly transforms over layout-changing animation.
- Background modules are isolated from content modules.
- A `BACKGROUND_EDIT` action lets the agent replace the background implementation with versioned code.

Performance budget:

- Startup background CSS must be inline or in the first critical CSS bundle.
- No large background images required for first paint.
- Cloud animation should use at most three layers and `transform: translate3d(...)`.
- Respect `prefers-reduced-motion`.
- Background replacement code must be sandboxed, versioned, revertible, and benchmarked before activation.

### 2. Runtime Choice

The first decision is still where the agent runs, but the choices are equal and visible:

- Cloud: sign in with Eliza Cloud, chat immediately with a tenant-isolated setup agent, provision the container in the background, then transfer conversation and memories into the container agent.
- Remote: enter or discover an existing agent URL, verify connectivity, and continue.
- Local: start model download immediately, warn about slow hardware or insufficient disk, and continue through setup while download runs.

Cloud behavior:

- No agent selection in Cloud. Each user gets one cloud agent.
- The setup agent uses the default Eliza character but is tenant-scoped and limited.
- A setup provider tells the agent setup is in progress and actions are limited.
- When the container is ready, chat transcript, extracted facts, and memories are handed to the container agent.
- The agent says and writes that setup is complete, then subsequent responses come from the container.

Local behavior:

- Local selection starts downloading the preferred Eliza-1 model immediately.
- If the user also has Eliza Cloud available, the app can use Cloud while the local model downloads.
- If no model is loaded, the agent tells the user it is still loading/downloading.
- At the end of onboarding, if the model is not ready, the agent says and writes: "I'm still downloading the local models, so you'll need to wait for me to finish to keep going."
- Hardware checks warn below 24 GB effective VRAM/shared memory and on insufficient disk space.

Remote behavior:

- Accept HTTPS/LAN URLs plus optional token.
- Clearly show connection verification and failure states.
- Remote is a setup path, not a separate product mode.

### 3. Language

Requirements:

- Ask for language after runtime choice.
- Language changes app copy and the agent's default language.
- No theme selector appears in onboarding.
- Language choice is persisted before voice setup, so voice prompts use the selected language when localized assets exist.

### 4. Speaker and Microphone Setup

Speaker step:

- Ask if it is okay to say hello out loud.
- If yes, play: "Hey, can you hear me?"
- User choices: Yes, Try again, Skip audio for now.
- If Yes, play: "Great, now lets see if I can hear you."

Retry voice lines:

- "Uhhh, how about now?"
- "If you're speaking, I can't hear you yet."
- "Eh, still nothing."
- "Helloooooo."
- "Testing, testing, one two, one two."
- "I mean it has to work this time."
- "Okay, this is getting a bit ridiculous."
- "Maybe the mic is shy."
- "I am listening as hard as software can listen."
- "Last one before I start blaming the cable."

Microphone step:

- Request mic permission.
- On desktop, show input selector when more than one input exists.
- Show a live waveform that moves when the mic has input.
- If no signal arrives, cycle voice lines every few seconds, then loop.
- User can confirm, retry, or skip.

### 5. Companion Screen

The post-onboarding screen is the companion screen:

- Sky/cloud background.
- Full-screen dynamic avatar module.
- Compact message stack.
- Composer pinned at bottom.
- Audio on/off state visible but restrained.

Composer behavior:

- Left button opens attachment source choices: image, music, PDF, file, camera/photo where available.
- Text input placeholder: "Ask anything".
- If there is no text, the right button is voice mode.
- If text exists, the right button becomes send.
- A dictate microphone sits next to the right button.
- Dictate mode turns dictate into X and right button into a checkmark.
- Voice mode turns the whole text input area into a live waveform until stopped.

Messages:

- Recent messages appear as compact headers/icons.
- Tapping expands a message.
- Only the last few messages show by default.
- Scrolling upward fades in the full history and expands collapsed messages smoothly.

### 6. Avatar Runtime

Requirements:

- Avatar is a full-screen dynamically loaded JS module.
- Initial preset: waveform shader.
- Additional presets: Jarvis and VRM 3D model.
- Character view includes an Avatar side menu item.
- Agent can edit avatar, create new avatars, and restore previous versions.
- Avatar modules must have a sandbox boundary, version history, and fallback.

Initial module contract:

```ts
export interface AvatarModule {
  id: string;
  title: string;
  kind: "canvas" | "webgl" | "react" | "vrm";
  mount(target: HTMLElement, context: AvatarContext): AvatarHandle;
}

export interface AvatarContext {
  audioLevel: () => number;
  speakingState: () => "idle" | "listening" | "thinking" | "speaking";
  theme: "sky";
  ownerName?: string;
}
```

### 7. Desktop Runtime

Requirements:

- On macOS, Windows, and Linux, Eliza runs as a tray app.
- After setup, desktop opens to the companion screen rather than the current multi-page shell.
- Desktop still exposes Views, Character, Settings, and other app surfaces.
- Add a thin bottom bar similar to Wispr Flow:
  - Collapsed by default.
  - Click or Ctrl Space expands into a chat bar with recent messages.
  - Mic button supports click-to-toggle and press-and-hold push-to-talk.
  - When always-on audio is enabled and the bar is collapsed, it glows softly red.
  - On macOS, holding Fn enables push-to-talk only when it does not interfere with normal Fn use.

### 8. Always-On Voice and Replay Buffer

Requirements:

- Always-on mode is encouraged but consented.
- The system records and transcribes ambient audio when enabled.
- Voice mode maintains a replay buffer of recent audio, including ignored speech.
- The agent only responds when addressed or when a response is expected.
- Users can pause, delete, export, and inspect captured audio/transcripts.
- Sensitive data handling must be explicit and auditable.

Response gating:

- Use VAD, wake intent, direct address detection, device context, and conversation state.
- Prefer silence when uncertain.
- Surface a subtle "heard but did not respond" trace in debug/history views.

### 9. Owner Knowledge

The onboarding agent should learn:

- User name and nicknames.
- Family, relationships, and friends.
- Work and role.
- Interests and routines.
- Goals and active projects.
- Important preferences.

Extraction rules:

- Facts are extracted by evaluators and post-actions, not brittle prompt text.
- Known facts are not repeatedly re-extracted unless new evidence changes them.
- Add nickname support either as a dedicated evaluator or as a typed fact subtype.
- Facts must be auditable, editable, and deletable.

### 10. Diarization and Voice Profiles

Requirements:

- Diarize speakers in chat/audio logs.
- Build voice profiles for speakers over time.
- Compare unknown speech to known profiles.
- Track more than 100 profiles.
- Know when the speaker is likely the owner.
- If confidence is low and protected access is requested, ask a private/personal challenge before granting access.

Data contract:

```ts
interface VoiceProfile {
  id: string;
  displayName?: string;
  owner: boolean;
  embeddingModel: string;
  embeddings: VoiceEmbeddingSummary[];
  quality: {
    samples: number;
    seconds: number;
    noiseFloor: number;
    lastUpdatedAt: string;
  };
  consent: "explicit" | "implicit-household" | "unknown";
}
```

### 11. Apps Become Views

Requirements:

- Rename user-facing "Apps" to "Views".
- Rename the Apps tab to Views.
- A view is a mini app generated by the agent or registered by a plugin.
- Plugins expose a `views` array of complete React-based views.
- The Views page itself is a view.
- Existing app terminology can remain internally during migration only behind compatibility aliases.

Plugin contract:

```ts
export interface PluginViewRegistration {
  id: string;
  title: string;
  description?: string;
  icon?: React.ComponentType;
  component: React.ComponentType<PluginViewProps>;
  permissions?: ViewPermission[];
  developerOnly?: boolean;
}

export interface ElizaPlugin {
  views?: PluginViewRegistration[];
  apps?: PluginViewRegistration[]; // deprecated compatibility alias
}
```

Agent view actions:

- `VIEW_CREATE`
- `VIEW_EDIT`
- `VIEW_REVERT`
- `VIEW_DELETE`
- `VIEW_RESTORE`
- `VIEW_OPEN`

### 12. Security and Privacy

- Cloud setup agent must be tenant-isolated.
- Setup actions are limited until provisioning completes.
- Memory transfer is explicit, logged, and scoped.
- Dynamic background/avatar/view code must be sandboxed and permissioned.
- Voice profiles require consent and local-first storage by default.
- Always-on capture requires visible state and fast pause.
- Protected actions require owner confidence or private challenge.

## Acceptance Criteria

- No white frame appears during cold load in browser, desktop, iOS, or Android.
- Cloud path lands in chat immediately after sign-in while provisioning continues.
- Cloud user never sees an agent picker.
- Local path starts model download before language selection and shows hardware/disk warnings when applicable.
- Language selection changes app copy and agent language.
- Speaker and mic flow can be completed, retried, or skipped.
- Companion screen is reachable after onboarding and is the default post-setup screen.
- Composer switches correctly between mic, send, dictate, and waveform modes.
- Desktop bar opens with Ctrl Space and supports push-to-talk/toggle mic states.
- User-facing navigation says Views, not Apps.
- Plugins can register `views`.
- Kokoro voice lines are generated or a build task documents why they could not be generated.
- E2E tests cover Cloud, Remote, Local downloading, skipped audio, successful audio, and desktop bar.

## Prototype

Interactive prototype:

`docs/prototypes/onboarding-reimagined/index.html`

Generated Kokoro audio assets:

`docs/prototypes/onboarding-reimagined/audio/`
