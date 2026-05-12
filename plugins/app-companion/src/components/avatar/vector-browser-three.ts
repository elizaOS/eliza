declare global {
  interface Navigator {
    readonly gpu?: unknown;
  }
}

import * as THREE from "three";

export { THREE };

type WebGpuRendererCtor = new (options?: {
  antialias?: boolean;
}) => THREE.WebGLRenderer & { init?: () => Promise<void> };

export async function createVectorBrowserRenderer(): Promise<THREE.WebGLRenderer> {
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const webgpuModule = (await import("three/webgpu")) as Record<
        string,
        unknown
      >;
      const WebGPURenderer = webgpuModule.WebGPURenderer as
        | WebGpuRendererCtor
        | undefined;
      if (WebGPURenderer) {
        const renderer = new (WebGPURenderer as WebGpuRendererCtor)({
          antialias: true,
        });
        await renderer.init?.();
        return renderer;
      }
    } catch {
      // Fall through to WebGL in environments without WebGPU support.
    }
  }

  return new THREE.WebGLRenderer({ antialias: true });
}
