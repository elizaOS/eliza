/**
 * Prompt builder for the HOMESCREEN action's edit/create modes.
 *
 * This is the single documented contract the model authors against: the scene
 * document shape it must emit, and — crucially — the live input signals an
 * authored `background.script` can read each frame. The action forwards the
 * model's JSON verbatim; the client (`packages/ui/src/homescreen/scene-validate`)
 * is the authority that validates and applies it. Keeping the schema described
 * here in prose (not imported types) preserves the dependency direction: the
 * plugin never imports the UI package.
 *
 * This prompt string is the GEPA optimization target for the
 * `homescreen_edit` task.
 */

export type HomescreenEditMode = "edit" | "create";

export interface HomescreenPromptParams {
  mode: HomescreenEditMode;
  /** Natural-language change the user asked for. */
  request: string;
  /** The current scene document as JSON, so edits are incremental. */
  currentSceneJson: string;
}

/** The input-contract block — what a `background.script` may read each frame. */
const INPUT_CONTRACT = `
The script body is the function body of \`(ctx) => SceneInstance\`. It returns a
SceneInstance: an object \`{ update(dt, time), dispose(), optimize?(tier) }\`.

\`ctx\` gives you (do not import anything; everything arrives on ctx):
  ctx.three     three.js / WebGPU namespace (THREE.*). Build meshes from this.
  ctx.scene     the THREE.Scene to add objects to (cleared on every scene swap).
  ctx.camera    the shared PerspectiveCamera.
  ctx.renderer  the renderer (do not dispose it; the host owns it).
  ctx.size      { width, height, dpr } backing-store dimensions.
  ctx.theme     { accent: [r,g,b] in 0..1, background: hex int } brand theme.
  ctx.inputs    LIVE, read-only signals the host mutates every frame:
    inputs.audioUser       mic amplitude while the user speaks, 0..1
    inputs.audioAssistant  TTS amplitude while the assistant speaks, 0..1
    inputs.energy          max(audioUser, audioAssistant) — the master "activity" knob
    inputs.bands           { low, mid, high } frequency bands of the active source, each 0..1
    inputs.pointer         { x, y, down } pointer in normalized device coords (-1..1)
    inputs.phase           "idle" | "listening" | "thinking" | "speaking"
    inputs.userText        most recent user message (string, may be empty)
    inputs.assistantText   most recent assistant message (string, may be empty)
    inputs.time            seconds since the scene mounted

SceneInstance.update(dt, time) runs every frame: read ctx.inputs and animate.
SceneInstance.optimize(tier) is OPTIONAL but recommended: when the device bogs
down the host calls it with a quality tier in 0..1 (1 = full, 0 = minimum) so you
can drop segment counts / disable transmission. Return the tier you settled on.
SceneInstance.dispose() must free every geometry, material, and texture you made.`;

/** The scene-document schema the model must emit. */
const SCENE_SCHEMA = `
Emit ONE JSON object (no markdown fence, no prose) with this shape:

{
  "name": "<short label, <= 60 chars>",
  "background": <one of:
     { "kind": "preset", "preset": "fresnel-crystal-ball" }      // a built-in
     { "kind": "script", "code": "<JS function body, see contract>" }
  >,
  "theme": {
    "accent": [r, g, b],          // each 0..1; the brand accent
    "background": 16734720         // page background as an integer hex color
  },
  "blocks": {
    "chat":          { "layout": <Layout>, "theme": <BlockTheme> },
    "apps":          { "layout": <Layout>, "theme": <BlockTheme> },
    "notifications": { "layout": <Layout>, "theme": <BlockTheme> }
  }
}

Layout = {
  "anchor": "top-left"|"top-center"|"top-right"|"bottom-left"|"bottom-center"|"bottom-right",
  "offset": { "x": <px>, "y": <px> },   // nudge from the anchor
  "collapsed": false,                    // true = render as a pill/handle
  "hidden": false                        // true = remove the block
}
BlockTheme = { "surface": <rgba string|null>, "text": <css color|null>,
               "radius": <px|null>, "blur": <px|null> }   // null = inherit`;

const BEST_PRACTICES = `
Rules:
- Keep blocks from colliding: default chat = bottom-center, apps = top-center,
  notifications = top-right. Only move a block if the user asks.
- Performance: prefer low-poly geometry, reuse materials, and implement
  optimize(tier) on anything heavy. The homescreen must hold 60fps on a laptop.
- Respect the brand: accent defaults to orange [1, 0.345, 0] unless the user
  asks to recolor. "make the background black" => theme.background = 0.
- For a custom look, author a "script" background. For a small tweak, keep the
  existing background and only change theme/blocks.`;

/**
 * Build the full prompt for an edit or create turn. `edit` keeps the current
 * scene as the base; `create` starts fresh from the request.
 */
export function buildHomescreenPrompt(params: HomescreenPromptParams): string {
  const intent =
    params.mode === "create"
      ? "Create a brand-new homescreen scene from this description."
      : "Apply this change to the current homescreen scene, keeping everything the user did not ask to change.";

  return [
    "You are the homescreen canvas designer for an AI assistant. You output a",
    "scene document that a WebGPU/three.js runtime renders behind the chat UI.",
    "",
    "INPUT CONTRACT",
    INPUT_CONTRACT.trim(),
    "",
    "OUTPUT SCHEMA",
    SCENE_SCHEMA.trim(),
    "",
    "DESIGN RULES",
    BEST_PRACTICES.trim(),
    "",
    "CURRENT SCENE (JSON):",
    params.currentSceneJson.trim(),
    "",
    "TASK",
    intent,
    `User request: ${params.request.replace(/\s+/g, " ").trim()}`,
    "",
    "Respond with ONLY the JSON scene document.",
  ].join("\n");
}

/**
 * Extract the first JSON object from a model response. Models often wrap output
 * in prose or a ```json fence despite instructions; this pulls the object out.
 * Returns null when no balanced object is found.
 */
export function extractSceneJson(raw: string): string | null {
  const text = raw.trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
