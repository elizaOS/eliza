/**
 * Three.js phone scene for the public homepage iMessage demonstration.
 *
 * The component maps the animated transcript onto a fixed phone and reports
 * when the camera and final chat frame are ready for visual capture.
 */
import { Canvas, useLoader, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  getMessageCount,
  renderChatToCanvas,
} from "@/components/ChatUI/renderChatToCanvas";

export interface ChatRenderState {
  phase: "animating" | "terminal";
  renderedMessages: number;
  totalMessages: number;
}

interface ModelBProps {
  onReady?: () => void;
  onChatRenderStateChange?: (state: ChatRenderState) => void;
}

interface ModelRuntime {
  invalidate: (() => void) | null;
  onReady: (() => void) | null;
  onChatRenderStateChange: ((state: ChatRenderState) => void) | null;
}

function createModelRuntime(): ModelRuntime {
  return {
    invalidate: null,
    onReady: null,
    onChatRenderStateChange: null,
  };
}

function configurePhoneLoader(loader: GLTFLoader) {
  loader.setMeshoptDecoder(MeshoptDecoder);
}

/** Builds a small reflection environment for the phone hardware materials. */
function PhoneEnvironment() {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const invalidate = useThree((state) => state.invalidate);

  useLayoutEffect(() => {
    const virtualScene = new THREE.Scene();
    const renderTarget = new THREE.WebGLCubeRenderTarget(64);
    renderTarget.texture.type = THREE.HalfFloatType;
    const camera = new THREE.CubeCamera(0.1, 1000, renderTarget);
    virtualScene.add(camera);

    const cards = [
      { intensity: 2, position: [0, 5, -6], scale: [10, 5, 1] },
      { intensity: 1.2, position: [-6, 1, 2], scale: [4, 8, 1] },
      { intensity: 0.8, position: [6, -2, 1], scale: [3, 5, 1] },
    ] as const;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const materials: THREE.MeshBasicMaterial[] = [];

    for (const card of cards) {
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color("white").multiplyScalar(card.intensity),
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(card.position[0], card.position[1], card.position[2]);
      mesh.scale.set(card.scale[0], card.scale[1], card.scale[2]);
      mesh.lookAt(0, 0, 0);
      materials.push(material);
      virtualScene.add(mesh);
    }

    const previousEnvironment = scene.environment;
    const autoClear = gl.autoClear;
    gl.autoClear = true;
    camera.update(gl, virtualScene);
    gl.autoClear = autoClear;
    scene.environment = renderTarget.texture;
    invalidate();

    return () => {
      scene.environment = previousEnvironment;
      geometry.dispose();
      for (const material of materials) material.dispose();
      renderTarget.dispose();
    };
  }, [gl, invalidate, scene]);

  return null;
}

function applyPhoneMaterial(child: THREE.Mesh, name: string) {
  if (name.includes("island")) {
    child.material = new THREE.MeshPhysicalMaterial({
      color: 0x000000,
      metalness: 1,
      roughness: 0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.05,
      reflectivity: 1,
    });
    return;
  }
  if (name.includes("camera")) {
    child.material = new THREE.MeshPhysicalMaterial({
      color: 0x000000,
      metalness: 0.2,
      roughness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0,
      reflectivity: 1,
    });
    return;
  }
  if (name.includes("flash")) {
    child.material = new THREE.MeshPhysicalMaterial({
      color: 0x444444,
      metalness: 0.2,
      roughness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0,
      reflectivity: 1,
    });
    return;
  }
  if (name.includes("iphone") || name.includes("phone")) {
    child.material = new THREE.MeshPhysicalMaterial({
      color: 0x444444,
      metalness: 0.35,
      roughness: 0.45,
      clearcoat: 0,
      clearcoatRoughness: 0.05,
      reflectivity: 1,
    });
  }
}

function PhoneModel({ runtime }: { runtime: ModelRuntime }) {
  const { scene: sourceScene } = useLoader(
    GLTFLoader,
    "/models/iphone-meshopt.glb",
    configurePhoneLoader,
  );
  const scene = useMemo(() => sourceScene.clone(true), [sourceScene]);
  const chatTextureRef = useRef<THREE.CanvasTexture | null>(null);
  const messageTimeoutRef = useRef(0);
  const messageFrameRef = useRef(0);
  const terminalFrameRef = useRef(0);
  const renderedTerminalFrameRef = useRef(0);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    runtime.invalidate = invalidate;
    return () => {
      runtime.invalidate = null;
    };
  }, [invalidate, runtime]);

  useEffect(() => {
    const avatarImage = new Image();
    avatarImage.src = "/brand/logos/logo_white_orangebg.svg";
    let cancelled = false;
    let initialized = false;

    const reportChatState = (
      phase: ChatRenderState["phase"],
      renderedMessages: number,
    ) => {
      runtime.onChatRenderStateChange?.({
        phase,
        renderedMessages,
        totalMessages: getMessageCount(),
      });
    };

    const setup = () => {
      if (cancelled || initialized) return;
      initialized = true;

      const totalMessages = getMessageCount();
      const prefersReducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;

      const initialCanvas = renderChatToCanvas(
        undefined,
        prefersReducedMotion ? totalMessages : 0,
        avatarImage.complete ? avatarImage : undefined,
      );
      const chatTexture = new THREE.CanvasTexture(initialCanvas);
      chatTexture.flipY = false;
      chatTexture.colorSpace = THREE.SRGBColorSpace;
      chatTextureRef.current = chatTexture;

      scene.traverse((child: THREE.Object3D) => {
        if (!(child instanceof THREE.Mesh)) return;
        const name = child.name.toLowerCase();
        if (name.includes("screen")) {
          child.material = new THREE.MeshBasicMaterial({ map: chatTexture });
          return;
        }
        applyPhoneMaterial(child, name);
      });

      if (prefersReducedMotion) {
        invalidate();
        terminalFrameRef.current = requestAnimationFrame(() => {
          if (cancelled) return;
          invalidate();
          renderedTerminalFrameRef.current = requestAnimationFrame(() => {
            if (cancelled) return;
            reportChatState("terminal", totalMessages);
          });
        });
        return;
      }

      let renderedMessages = 0;
      reportChatState("animating", renderedMessages);
      invalidate();

      const renderMessage = () => {
        if (cancelled) return;
        renderedMessages += 1;
        const animationStartedAt = performance.now();

        const tick = (now: number) => {
          if (cancelled) return;
          const progress = Math.min((now - animationStartedAt) / 300, 1);
          const easedProgress = 1 - (1 - progress) ** 3;
          chatTexture.image = renderChatToCanvas(
            chatTexture.image as HTMLCanvasElement,
            renderedMessages,
            avatarImage.complete ? avatarImage : undefined,
            easedProgress,
          );
          chatTexture.needsUpdate = true;
          invalidate();

          if (progress < 1) {
            messageFrameRef.current = requestAnimationFrame(tick);
            return;
          }

          if (renderedMessages < totalMessages) {
            reportChatState("animating", renderedMessages);
            messageTimeoutRef.current = window.setTimeout(renderMessage, 650);
            return;
          }

          terminalFrameRef.current = requestAnimationFrame(() => {
            if (cancelled) return;
            invalidate();
            renderedTerminalFrameRef.current = requestAnimationFrame(() => {
              if (cancelled) return;
              reportChatState("terminal", totalMessages);
            });
          });
        };

        messageFrameRef.current = requestAnimationFrame(tick);
      };

      messageTimeoutRef.current = window.setTimeout(renderMessage, 300);
    };

    avatarImage.onload = setup;
    avatarImage.onerror = setup;
    if (avatarImage.complete) setup();

    return () => {
      cancelled = true;
      clearTimeout(messageTimeoutRef.current);
      cancelAnimationFrame(messageFrameRef.current);
      cancelAnimationFrame(terminalFrameRef.current);
      cancelAnimationFrame(renderedTerminalFrameRef.current);
      scene.traverse((child: THREE.Object3D) => {
        if (!(child instanceof THREE.Mesh)) return;
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        for (const material of materials) material.dispose();
      });
      chatTextureRef.current?.dispose();
    };
  }, [invalidate, runtime, scene]);

  return <primitive object={scene} position={[0, 0, 3.6]} />;
}

useLoader.preload(
  GLTFLoader,
  "/models/iphone-meshopt.glb",
  configurePhoneLoader,
);

function FinalCamera({ runtime }: { runtime: ModelRuntime }) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);

  useLayoutEffect(() => {
    const perspectiveCamera = camera as THREE.PerspectiveCamera;
    perspectiveCamera.fov = 90;
    perspectiveCamera.position.y = 8;
    perspectiveCamera.updateProjectionMatrix();
    invalidate();

    let renderedFrame = 0;
    const readyFrame = requestAnimationFrame(() => {
      invalidate();
      renderedFrame = requestAnimationFrame(() => runtime.onReady?.());
    });
    return () => {
      cancelAnimationFrame(readyFrame);
      cancelAnimationFrame(renderedFrame);
    };
  }, [camera, invalidate, runtime]);

  return null;
}

export default function ModelB({
  onReady,
  onChatRenderStateChange,
}: ModelBProps) {
  const runtime = useMemo(createModelRuntime, []);
  // Camera readiness can be reported before parent passive effects run, so
  // keep the current callbacks available synchronously during child layout.
  runtime.onReady = onReady ?? null;
  runtime.onChatRenderStateChange = onChatRenderStateChange ?? null;

  return (
    <div className="fixed inset-0" data-phone-scene>
      <Canvas
        camera={{ position: [0, 8, 0.6], fov: 90 }}
        dpr={[1, 1.5]}
        frameloop="demand"
        gl={{
          alpha: true,
          powerPreference: "high-performance",
          toneMapping: THREE.NoToneMapping,
        }}
      >
        <ambientLight intensity={0.5} />
        <PhoneModel runtime={runtime} />
        <PhoneEnvironment />
        <FinalCamera runtime={runtime} />
      </Canvas>
    </div>
  );
}
