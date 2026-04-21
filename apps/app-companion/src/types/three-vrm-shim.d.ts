declare module "@pixiv/three-vrm" {
  import type { Object3D } from "three";

  export class MToonMaterialLoaderPlugin {
    constructor(...args: unknown[]);
  }
  export type VRMHumanBoneName = string;

  export interface VRMHumanoid {
    normalizedRestPose: {
      hips?: {
        position?: ArrayLike<number>;
      };
    };
    getNormalizedBoneNode: (name: VRMHumanBoneName | string) => Object3D | null;
    getRawBoneNode: (name: VRMHumanBoneName | string) => Object3D | null;
    update?: () => void;
  }

  export interface VRMLookAt {
    autoUpdate?: boolean;
    target?: Object3D | null;
    update: (delta: number) => void;
  }

  export interface VRMExpressionManager {
    setValue: (name: string, value: number) => void;
    update: () => void;
  }

  export interface VRM {
    scene: Object3D;
    meta?: { metaVersion?: string } | null;
    humanoid?: VRMHumanoid | null;
    lookAt?: VRMLookAt | null;
    expressionManager?: VRMExpressionManager | null;
    springBoneManager?: {
      reset?: () => void;
    } | null;
    update: (delta: number) => void;
    [key: string]: unknown;
  }

  export class VRMLoaderPlugin {
    name: string;
    constructor(...args: unknown[]);
  }

  export const VRMUtils: {
    rotateVRM0: (vrm: VRM) => void;
    deepDispose: (object: Object3D) => void;
    removeUnnecessaryVertices: (object: Object3D) => void;
  };
}

declare module "@pixiv/three-vrm/nodes" {
  export class MToonNodeMaterial {}
}
