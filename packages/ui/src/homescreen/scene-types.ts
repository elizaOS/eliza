/**
 * Homescreen canvas — scene-document model and runtime input contract.
 *
 * This module is the single source of truth for the customizable homescreen:
 *   - the runtime ({@link ./scene-runtime}) consumes {@link SceneFactory} +
 *     {@link SceneRenderContext},
 *   - the HOMESCREEN agent action validates its output against
 *     {@link HomescreenScene},
 *   - the LLM edit-prompt documents {@link SceneInputs} so authored scripts know
 *     exactly what live signals they can read,
 *   - persistence/history ({@link ./scene-history}) serializes
 *     {@link HomescreenScene}.
 *
 * Keep this dependency-free (no three.js import) so it is safe to import from
 * the action layer, tests, and prompt builders without pulling the WebGPU build.
 */

/** Coarse interaction phase, mirrors the voice avatar's mode. */
export type HomescreenPhase = "idle" | "listening" | "thinking" | "speaking";

/**
 * Live signals a scene reads each frame. This is the INPUT CONTRACT — the exact
 * surface documented to the LLM so an authored `background.script` can react to
 * voice, touch, and conversation. All amplitudes are normalized [0,1]. The
 * runtime owns this object and mutates it in place; scenes must treat it as
 * read-only.
 */
export interface SceneInputs {
  /** Microphone amplitude while the user speaks, [0,1]. */
  audioUser: number;
  /** TTS playback amplitude while the assistant speaks, [0,1]. */
  audioAssistant: number;
  /** max(audioUser, audioAssistant) — the single "is something happening" knob. */
  energy: number;
  /** Low/mid/high frequency bands of the active source, each [0,1]. */
  bands: { low: number; mid: number; high: number };
  /** Pointer / touch position in normalized device coords (-1..1), plus press. */
  pointer: { x: number; y: number; down: boolean };
  /** Current interaction phase. */
  phase: HomescreenPhase;
  /** Most recent user message text (empty when none). */
  userText: string;
  /** Most recent assistant message text (empty when none). */
  assistantText: string;
  /** Seconds since the scene mounted. */
  time: number;
}

/** Brand/theme values handed to a scene so it can match the active surface. */
export interface SceneTheme {
  /** Accent as linear [r,g,b] in 0..1 (resolved from --accent-rgb). */
  accent: [number, number, number];
  /** Background color as a hex int (e.g. 0xff5800). */
  background: number;
}

/**
 * What a {@link SceneFactory} receives. `three` and `scene` are typed as unknown
 * here to keep this file free of the three.js types; the runtime narrows them.
 */
export interface SceneRenderContext {
  /** three/webgpu (or three) namespace. */
  three: unknown;
  /** The THREE.Scene to populate; cleared between scene swaps. */
  scene: unknown;
  /** The shared THREE.PerspectiveCamera. */
  camera: unknown;
  /** The shared renderer (WebGPURenderer or WebGLRenderer). */
  renderer: unknown;
  /** Backing-store dimensions. */
  size: { width: number; height: number; dpr: number };
  /** Theme values. */
  theme: SceneTheme;
  /** Live, runtime-owned input signals (read-only for scenes). */
  inputs: Readonly<SceneInputs>;
}

/**
 * A mounted scene. `update` runs every frame; `optimize` is invoked by the
 * performance governor when the device is bogging down so the scene can shed
 * detail (lower segment counts, disable transmission, etc). Returning the new
 * quality tier lets the governor decide whether to keep optimizing.
 */
export interface SceneInstance {
  update(dt: number, time: number): void;
  /** Optional voluntary degrade. Return the resulting quality tier in [0,1]. */
  optimize?(targetTier: number): number;
  dispose(): void;
}

/** Builds a {@link SceneInstance} from a render context. */
export type SceneFactory = (ctx: SceneRenderContext) => SceneInstance;

// ── Foreground blocks ────────────────────────────────────────────────────────

/** The themeable foreground blocks that live on top of the canvas. */
export type BlockId = "chat" | "apps" | "notifications";

export const BLOCK_IDS: readonly BlockId[] = ["chat", "apps", "notifications"];

/**
 * Where a block sits. Anchors keep blocks from colliding by default: chat is
 * bottom-center, apps top-center, notifications top-right. `offset` lets the
 * user nudge from the anchor (in px) without losing the responsive anchor.
 */
export interface BlockLayout {
  anchor:
    | "top-left"
    | "top-center"
    | "top-right"
    | "bottom-left"
    | "bottom-center"
    | "bottom-right";
  offset: { x: number; y: number };
  /** Collapsed blocks render as a pill/handle so the canvas reads through. */
  collapsed: boolean;
  /** Hidden blocks are removed entirely (still restorable from history). */
  hidden: boolean;
}

/** Per-block visual overrides; unset fields inherit the surface theme. */
export interface BlockTheme {
  /** Glass tint as rgba string, or null to inherit. */
  surface?: string | null;
  /** Text color, or null to inherit. */
  text?: string | null;
  /** Corner radius in px. */
  radius?: number | null;
  /** Backdrop blur in px. */
  blur?: number | null;
}

export interface BlockConfig {
  layout: BlockLayout;
  theme: BlockTheme;
}

export type BlocksConfig = Record<BlockId, BlockConfig>;

// ── The serializable scene document ──────────────────────────────────────────

/** How the background canvas is produced. */
export type SceneBackground =
  | { kind: "preset"; preset: string }
  | {
      /**
       * An agent/user-authored module. `code` is the body of a factory with the
       * signature `(ctx: SceneRenderContext) => SceneInstance`, evaluated by the
       * runtime in a constrained scope. Never persisted from untrusted remote
       * sources without review.
       */
      kind: "script";
      code: string;
    };

/**
 * A complete, serializable homescreen. This is what the HOMESCREEN action emits,
 * what persistence stores, and what the history stack snapshots for undo/redo.
 */
export interface HomescreenScene {
  /** Stable id (uuid-ish). */
  id: string;
  /** Human label shown in the editor / history. */
  name: string;
  /** Document schema version for forward migration. */
  version: 1;
  background: SceneBackground;
  theme: SceneTheme;
  blocks: BlocksConfig;
  /** Epoch ms the document was created/last edited. */
  updatedAt: number;
}

/** Built-in preset keys. The default is always available. */
export const BUILTIN_PRESETS = {
  /** White Fresnel crystal-ball over orange with the eliza mark suspended inside. */
  fresnelCrystalBall: "fresnel-crystal-ball",
} as const;

export type BuiltinPreset =
  (typeof BUILTIN_PRESETS)[keyof typeof BUILTIN_PRESETS];

const defaultLayout = (anchor: BlockLayout["anchor"]): BlockLayout => ({
  anchor,
  offset: { x: 0, y: 0 },
  collapsed: false,
  hidden: false,
});

const defaultBlock = (anchor: BlockLayout["anchor"]): BlockConfig => ({
  layout: defaultLayout(anchor),
  theme: { surface: null, text: null, radius: null, blur: null },
});

/** Sane, non-colliding default block placement. */
export function defaultBlocks(): BlocksConfig {
  return {
    apps: defaultBlock("top-center"),
    notifications: defaultBlock("top-right"),
    chat: defaultBlock("bottom-center"),
  };
}

/** Brand orange default theme. */
export const DEFAULT_THEME: SceneTheme = {
  accent: [1, 0.345, 0],
  background: 0xff5800,
};

/** The factory default homescreen: the Fresnel crystal ball. */
export function createDefaultScene(): HomescreenScene {
  return {
    id: "default",
    name: "Crystal ball",
    version: 1,
    background: { kind: "preset", preset: BUILTIN_PRESETS.fresnelCrystalBall },
    theme: { ...DEFAULT_THEME },
    blocks: defaultBlocks(),
    updatedAt: 0,
  };
}
