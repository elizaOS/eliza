import * as THREE from "three";

export { THREE };

type WebGpuRendererCtor = new (options?: {
  antialias?: boolean;
}) => THREE.WebGLRenderer & { init?: () => Promise<void> };

export async function createVectorBrowserRenderer(): Promise<THREE.WebGLRenderer> {
  if (typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const webgpuModule = (await import("three/webgpu")) as unknown as {
        WebGPURenderer?: WebGpuRendererCtor;
      };
      const WebGPURenderer = webgpuModule.WebGPURenderer;
      if (WebGPURenderer) {
        const renderer = new WebGPURenderer({ antialias: true });
        await renderer.init?.();
        return renderer;
      }
    } catch {
      // Fall through to WebGL in environments without WebGPU support.
    }
  }

  return new THREE.WebGLRenderer({ antialias: true });
}
