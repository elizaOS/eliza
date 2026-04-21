/**
 * Ambient type declarations for three.js subpath modules that are only
 * available at runtime via dynamic import (WebGPU / TSL). These modules
 * ship in newer three.js builds but lack standalone type packages.
 */

declare module "three/webgpu" {
  import type * as THREE from "three";
  export class WebGPURenderer extends THREE.WebGLRenderer {
    constructor(parameters?: THREE.WebGLRendererParameters);
  }
}

/**
 * three/tsl (Three Shading Language) — node-based shader graph API.
 * Every function returns a ShaderNode that supports chained arithmetic.
 */
declare module "three/tsl" {
  // biome-ignore lint/suspicious/noExplicitAny: TSL nodes are heavily dynamic
  type ShaderNode = any;

  export function uniform(value: number): ShaderNode;
  export function float(value: number | ShaderNode): ShaderNode;
  export function smoothstep(
    edge0: ShaderNode,
    edge1: ShaderNode,
    x: ShaderNode,
  ): ShaderNode;
  export function mix(x: ShaderNode, y: ShaderNode, a: ShaderNode): ShaderNode;
  export const positionWorld: ShaderNode;
  export function vec3(
    x: ShaderNode | number,
    y: ShaderNode | number,
    z: ShaderNode | number,
  ): ShaderNode;
  export function sin(x: ShaderNode): ShaderNode;
  export function cos(x: ShaderNode): ShaderNode;
  export function mul(a: ShaderNode, b: ShaderNode): ShaderNode;
  export function add(a: ShaderNode, b: ShaderNode): ShaderNode;
  export function sub(a: ShaderNode, b: ShaderNode): ShaderNode;
  export function step(edge: ShaderNode, x: ShaderNode): ShaderNode;
  export function fract(x: ShaderNode): ShaderNode;
  export function discard(condition: ShaderNode): void;
}
