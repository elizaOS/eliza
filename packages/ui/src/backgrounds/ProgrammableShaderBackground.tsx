/**
 * ProgrammableShaderBackground — a real GLSL fragment-shader wallpaper rendered
 * via raw three.js (already a dependency of @elizaos/ui; NO new deps) (#10694).
 *
 * Arbitrary GLSL is untrusted GPU code, so safety is a hard requirement and this
 * component treats a bad shader as expected, not exceptional:
 *   1. compile-validate the fragment source in the live GL context BEFORE the
 *      material is ever shown; a compile error → onFallback (never a blank frame);
 *   2. all tunable uniforms are re-clamped at the boundary;
 *   3. a frame-time watchdog stops the loop and falls back if the GPU stalls;
 *   4. WebGL context loss is caught (default prevented) and a restore triggers a
 *      clean fallback rather than a dead canvas;
 *   5. prefers-reduced-motion renders a single static frame (no rAF).
 * Any failure calls onFallback and the parent (AppBackground) paints the plain
 * color field instead — a hostile shader can never white-screen or hang the app.
 */

import type * as React from "react";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import {
  hexToRgb,
  normalizeUniforms,
  type ShaderUniformValues,
} from "./shader-schema";

/** RawShaderMaterial gets no three.js injection, so the vertex stage is explicit.
 * A single fullscreen triangle covers clip space with one primitive. */
const VERTEX_SOURCE = `attribute vec3 position;
void main(){ gl_Position = vec4(position, 1.0); }`;

export interface ProgrammableShaderBackgroundProps {
  /** GLSL ES 1.00 fragment source (already static-gated upstream). */
  source: string;
  /** Tunable uniform values; re-clamped here defensively. */
  uniforms: ShaderUniformValues;
  /** Base color hex driving `u_color`. */
  color: string;
  /** Called when the shader can't run (no WebGL, compile error, GPU stall,
   * context loss). The parent swaps in the color-field fallback. */
  onFallback?: (reason: string) => void;
}

/** Compile-validate a fragment shader in the live GL context. Returns the
 * info-log on failure, or null on success. */
function fragmentCompileError(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  source: string,
): string | null {
  const sh = gl.createShader(gl.FRAGMENT_SHADER);
  if (!sh) return "could not allocate shader";
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
  const log = ok
    ? null
    : gl.getShaderInfoLog(sh) || "fragment shader failed to compile";
  gl.deleteShader(sh);
  return log;
}

export function ProgrammableShaderBackground({
  source,
  uniforms,
  color,
  onFallback,
}: ProgrammableShaderBackgroundProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef(onFallback);
  fallbackRef.current = onFallback;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fallback = (reason: string) => fallbackRef.current?.(reason);

    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        powerPreference: "low-power",
      });
    } catch {
      fallback("no-webgl");
      return;
    }
    const gl = renderer.getContext();

    // (1) compile-validate BEFORE building the material / attaching the canvas.
    const compileError = fragmentCompileError(gl, source);
    if (compileError) {
      renderer.dispose();
      fallback(`compile: ${compileError.slice(0, 200)}`);
      return;
    }

    const clamped = normalizeUniforms(uniforms);
    const dpr = Math.min(
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      2,
    );
    const width = host.clientWidth || 1;
    const height = host.clientHeight || 1;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);

    const canvas = renderer.domElement;
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(
        new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]),
        3,
      ),
    );
    const [r, g, b] = hexToRgb(color);
    const uniformDefs: Record<string, THREE.IUniform> = {
      u_time: { value: 0 },
      u_resolution: { value: new THREE.Vector2(width * dpr, height * dpr) },
      u_color: { value: new THREE.Vector3(r, g, b) },
      u_speed: { value: clamped.u_speed },
      u_scale: { value: clamped.u_scale },
      u_intensity: { value: clamped.u_intensity },
      u_seed: { value: clamped.u_seed },
    };
    const material = new THREE.RawShaderMaterial({
      vertexShader: VERTEX_SOURCE,
      fragmentShader: source,
      uniforms: uniformDefs,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    let raf = 0;
    let disposed = false;
    let slowFrames = 0;

    const cleanup = () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      geometry.dispose();
      material.dispose();
      renderer?.dispose();
      if (canvas.parentNode === host) host.removeChild(canvas);
    };

    // (4) context-loss recovery: block the default (which permanently kills the
    // context) and fall back on restore rather than leaving a dead canvas.
    const onContextLost = (e: Event) => {
      e.preventDefault();
      if (raf) cancelAnimationFrame(raf);
    };
    const onContextRestored = () => {
      if (!disposed) fallback("context-restored");
    };
    canvas.addEventListener("webglcontextlost", onContextLost, false);
    canvas.addEventListener("webglcontextrestored", onContextRestored, false);

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (disposed || !renderer) return;
            const w = host.clientWidth || 1;
            const h = host.clientHeight || 1;
            renderer.setSize(w, h, false);
            (uniformDefs.u_resolution.value as THREE.Vector2).set(
              w * dpr,
              h * dpr,
            );
          })
        : null;
    resizeObserver?.observe(host);

    const start = typeof performance !== "undefined" ? performance.now() : 0;
    const renderAt = (timeSec: number) => {
      uniformDefs.u_time.value = timeSec;
      renderer?.render(scene, camera);
    };

    if (reduceMotion) {
      // (5) reduced-motion: one static frame at the seed phase, no animation.
      renderAt(clamped.u_seed);
      return cleanup;
    }

    // (3) frame-time watchdog: a shader that stalls the GPU makes frames huge;
    // after several consecutive slow frames, stop and fall back.
    let last = start;
    const loop = () => {
      const now =
        typeof performance !== "undefined" ? performance.now() : last + 16;
      const dt = now - last;
      last = now;
      if (dt > 120) {
        slowFrames += 1;
        if (slowFrames >= 5) {
          fallback("gpu-stall");
          return; // stop the loop; the parent swaps us out
        }
      } else if (slowFrames > 0) {
        slowFrames -= 1;
      }
      renderAt((now - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return cleanup;
  }, [source, uniforms, color]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-testid="app-background-glsl"
      data-eliza-bg="glsl"
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ zIndex: 0, backgroundColor: color }}
    />
  );
}
