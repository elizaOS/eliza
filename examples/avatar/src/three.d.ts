declare module "three" {
  export namespace THREE {
    type Object3D = any;
    const Object3D: new (...args: any[]) => any;
    type Group = any;
    const Group: new (...args: any[]) => any;
    type Scene = any;
    const Scene: new (...args: any[]) => any;
    type Vector3 = any;
    const Vector3: new (...args: any[]) => any;
    type Quaternion = any;
    const Quaternion: new (...args: any[]) => any;
    type Box3 = any;
    const Box3: new (...args: any[]) => any;
    type WebGLRenderer = any;
    const WebGLRenderer: new (...args: any[]) => any;
    type PerspectiveCamera = any;
    const PerspectiveCamera: new (...args: any[]) => any;
    type Clock = any;
    const Clock: new (...args: any[]) => any;
    type AnimationMixer = any;
    const AnimationMixer: new (...args: any[]) => any;
    type AnimationAction = any;
    const AnimationAction: new (...args: any[]) => any;
    type AnimationClip = any;
    interface AnimationClipConstructor {
      new (...args: any[]): any;
      findByName(animations: any[], name: string): any;
    }
    const AnimationClip: AnimationClipConstructor;
    type QuaternionKeyframeTrack = any;
    const QuaternionKeyframeTrack: new (...args: any[]) => any;
    type VectorKeyframeTrack = any;
    const VectorKeyframeTrack: new (...args: any[]) => any;
    type DirectionalLight = any;
    const DirectionalLight: new (...args: any[]) => any;
    type AmbientLight = any;
    const AmbientLight: new (...args: any[]) => any;
    const LoopRepeat: any;
  }
  export = THREE;
}

declare module "three/examples/jsm/loaders/GLTFLoader.js" {
  export class GLTFLoader {
    register(callback: (parser: unknown) => unknown): void;
    load(
      url: string,
      onLoad?: (result: unknown) => void,
      onProgress?: (event: ProgressEvent) => void,
      onError?: (event: unknown) => void
    ): void;
    loadAsync(url: string): Promise<unknown>;
  }
}

declare module "three/examples/jsm/loaders/FBXLoader.js" {
  export class FBXLoader {
    load(
      url: string,
      onLoad?: (result: unknown) => void,
      onProgress?: (event: ProgressEvent) => void,
      onError?: (event: unknown) => void
    ): void;
    loadAsync(url: string): Promise<unknown>;
  }
}
