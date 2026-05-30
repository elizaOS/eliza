/**
 * Resolves a {@link SceneBackground} document into a live {@link SceneFactory}.
 *
 * Two paths:
 *   - `preset`: a built-in factory registered in {@link presetRegistry}. Trusted,
 *     ships with the app.
 *   - `script`: an agent/user-authored body compiled in a constrained scope. The
 *     code is the function body of `(ctx: SceneRenderContext) => SceneInstance`.
 *
 * The three.js / WebGPU wiring lives in the React host (it owns the canvas,
 * renderer, and frame loop). This module is GPU-free and pure: it compiles and
 * looks up factories, and builds the runtime-owned input object. That keeps the
 * dangerous part — turning a string into executable code — small, isolated, and
 * unit-testable without a GPU.
 */

import {
  createDefaultScene,
  type SceneBackground,
  type SceneFactory,
  type SceneInputs,
} from "./scene-types";

// ── Preset registry ──────────────────────────────────────────────────────────

const presetRegistry = new Map<string, SceneFactory>();

/** Register a built-in scene factory under a preset key. */
export function registerPreset(key: string, factory: SceneFactory): void {
  presetRegistry.set(key, factory);
}

/** Look up a registered preset factory. */
export function getPreset(key: string): SceneFactory | undefined {
  return presetRegistry.get(key);
}

/** All registered preset keys (for editor pickers / validation). */
export function presetKeys(): string[] {
  return [...presetRegistry.keys()];
}

// ── Script sandbox ───────────────────────────────────────────────────────────

/**
 * Globals shadowed to `undefined` inside a compiled script so casual access to
 * the page, network, storage, and timers fails. This is a guardrail, not a
 * security boundary — a determined script can still reach globals through
 * constructor chains. Untrusted remote scripts must be reviewed before they are
 * ever persisted (see {@link SceneBackground}).
 */
const SHADOWED_GLOBALS = [
  "window",
  "document",
  "globalThis",
  "self",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "navigator",
  "location",
  "Function",
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "process",
  "require",
] as const;

export interface ScriptCompileOk {
  ok: true;
  factory: SceneFactory;
}
export interface ScriptCompileErr {
  ok: false;
  error: string;
}
export type ScriptCompileResult = ScriptCompileOk | ScriptCompileErr;

/**
 * Compile a script body into a {@link SceneFactory}. The body receives a single
 * `ctx` argument and must `return` a {@link SceneInstance}. Compilation failures
 * (syntax errors) are returned, never thrown, so the editor can surface them and
 * keep the prior scene.
 */
export function compileSceneScript(code: string): ScriptCompileResult {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "script body is empty" };
  }
  try {
    // Build `(ctx, ...shadowed) => { <body> }` and bind the shadowed names to
    // undefined so the body sees them as unavailable.
    const compiled = new Function(
      "ctx",
      ...SHADOWED_GLOBALS,
      `"use strict";\n${trimmed}`,
    ) as (...args: unknown[]) => unknown;
    const factory: SceneFactory = (ctx) => {
      const instance = compiled(ctx, ...SHADOWED_GLOBALS.map(() => undefined));
      if (
        !instance ||
        typeof instance !== "object" ||
        typeof (instance as { update?: unknown }).update !== "function" ||
        typeof (instance as { dispose?: unknown }).dispose !== "function"
      ) {
        throw new Error(
          "script must return a SceneInstance with update() and dispose()",
        );
      }
      return instance as ReturnType<SceneFactory>;
    };
    return { ok: true, factory };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Background → factory ─────────────────────────────────────────────────────

export interface FactoryResolveOk {
  ok: true;
  factory: SceneFactory;
}
export interface FactoryResolveErr {
  ok: false;
  error: string;
}
export type FactoryResolveResult = FactoryResolveOk | FactoryResolveErr;

/**
 * Resolve a validated {@link SceneBackground} into a runnable factory. A preset
 * that isn't registered or a script that won't compile is a resolve error; the
 * host falls back to the default scene.
 */
export function resolveSceneFactory(
  background: SceneBackground,
): FactoryResolveResult {
  if (background.kind === "preset") {
    const factory = getPreset(background.preset);
    if (!factory) {
      return { ok: false, error: `unknown preset "${background.preset}"` };
    }
    return { ok: true, factory };
  }
  const compiled = compileSceneScript(background.code);
  if (!compiled.ok) return { ok: false, error: compiled.error };
  return { ok: true, factory: compiled.factory };
}

// ── Runtime-owned inputs ─────────────────────────────────────────────────────

/**
 * Build the zeroed input object the host mutates in place each frame. Scenes
 * treat it as read-only; this is the one place it is constructed.
 */
export function createSceneInputs(): SceneInputs {
  return {
    audioUser: 0,
    audioAssistant: 0,
    energy: 0,
    bands: { low: 0, mid: 0, high: 0 },
    pointer: { x: 0, y: 0, down: false },
    phase: "idle",
    userText: "",
    assistantText: "",
    time: 0,
  };
}

/**
 * Resolve a background to a factory, falling back to the default preset's
 * factory if resolution fails. Returns the factory plus any error string for the
 * host to surface. The default preset must be registered for the fallback to
 * succeed; if it isn't, the error is propagated and no factory is returned.
 */
export function resolveSceneFactoryOrDefault(
  background: SceneBackground,
): { factory: SceneFactory | null; error: string | null } {
  const direct = resolveSceneFactory(background);
  if (direct.ok) return { factory: direct.factory, error: null };
  const fallback = resolveSceneFactory(createDefaultScene().background);
  return {
    factory: fallback.ok ? fallback.factory : null,
    error: direct.error,
  };
}
