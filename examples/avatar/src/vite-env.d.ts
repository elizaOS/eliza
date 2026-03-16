/// <reference types="vite/client" />

// Type declaration for @vitejs/plugin-react
declare module "@vitejs/plugin-react" {
  import type { Plugin } from "vite";
  export default function react(options?: any): Plugin;
}

// Plugin shims for optional dependencies
declare module "@elizaos/plugin-anthropic" {
  const plugin: unknown;
  export default plugin;
}
declare module "@elizaos/plugin-eliza-classic" {
  export const elizaClassicPlugin: unknown;
  export function getElizaGreeting(): string;
}
declare module "@elizaos/plugin-elevenlabs" {
  const plugin: unknown;
  export default plugin;
}
declare module "@elizaos/plugin-google-genai" {
  const plugin: unknown;
  export default plugin;
}
declare module "@elizaos/plugin-groq" {
  const plugin: unknown;
  export default plugin;
}
declare module "@elizaos/plugin-openai" {
  export const openaiPlugin: unknown;
}
declare module "@elizaos/plugin-simple-voice" {
  export const simpleVoicePlugin: unknown;
  export const SamTTSService: unknown;
}

// Three.js: loose stubs so THREE types and values work without @types/three
declare module "three" {
  namespace THREE {
    class WebGLRenderer {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class Scene {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class PerspectiveCamera {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class Clock {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class AnimationMixer {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class AnimationAction {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class Vector3 {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class Group {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class Object3D {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class Box3 {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class Quaternion {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class AnimationClip {
      [key: string]: any;
      constructor(...args: any[]);
      static findByName(clips: any[], name: string): any;
    }
    class QuaternionKeyframeTrack {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class VectorKeyframeTrack {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class DirectionalLight {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class AmbientLight {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class Mesh {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class BufferGeometry {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class Material {
      [key: string]: any;
      constructor(...args: any[]);
    }
    class NumberKeyframeTrack {
      [key: string]: any;
      constructor(...args: any[]);
    }
    const LoopRepeat: number;
  }
  const THREE: typeof THREE;
  export = THREE;
}
// Three.js subpath modules
declare module "three/examples/jsm/loaders/GLTFLoader.js" {
  const GLTFLoader: any;
  export { GLTFLoader };
}
declare module "three/examples/jsm/loaders/FBXLoader.js" {
  const FBXLoader: any;
  export { FBXLoader };
}
