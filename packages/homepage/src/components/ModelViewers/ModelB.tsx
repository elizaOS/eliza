/**
 * Three.js phone model scene for the homepage onboarding demo.
 *
 * The component maps the canvas-rendered chat UI onto the model screen and
 * exposes imperative controls used by the surrounding onboarding flow.
 */
import { animated, useSpring } from "@react-spring/three";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  BACK_BTN_CY,
  BACK_BTN_H,
  BACK_BTN_W_ESTIMATE,
  BACK_BTN_X,
  CANVAS_H,
  CANVAS_W,
  type ExtraMessage,
  getMessageCount,
  measureBubbleHeight,
  measurePreloadedScrollHeight,
  renderChatToCanvas,
  setChatPlatform,
  TYPING_BUBBLE_HEIGHT,
  VID_BTN_CX,
  VID_BTN_CY,
} from "@/components/ChatUI/renderChatToCanvas";
import { useT } from "@/providers/I18nProvider";

export interface ModelBHandle {
  spin: (direction?: 1 | -1) => void;
  restartMessages: () => void;
  sendMessage: (text: string) => void;
  slideDown: () => void;
}

interface ModelBProps {
  tryActive?: boolean;
  switcherOpen?: boolean;
  onWaitingChange?: (waiting: boolean) => void;
  onBackClick?: () => void;
  onVideoClick?: () => void;
  onReady?: () => void;
  onSwitcherDone?: () => void;
  onSwitcherOpen?: () => void;
  loginTitle?: string;
  loginSubtitle?: string;
  platform?: string;
  introDelayMs?: number;
}

const DEFAULT_BOT_RESPONSES = [
  "sure thing! i'll take care of that right away",
  "on it — give me just a sec",
  "great idea, let me set that up for you and send a confirmation when it's done",
  "done! anything else?",
  "absolutely, i've got you covered. made a few adjustments along the way",
  "just looked into it — all sorted!",
  "no worries, i'll handle that for you. want me to look into anything else?",
  "good thinking! already on it",
  "all done! organized everything so it's easier to find next time",
  "consider it handled",
];

type SwitcherPhase = "idle" | "opening" | "open" | "closing";

interface ModelRuntime {
  triggerSpin: ((direction: 1 | -1) => void) | null;
  triggerRestartMessages: (() => void) | null;
  triggerSendMessage: ((text: string) => void) | null;
  triggerSlideDown: (() => void) | null;
  invalidate: (() => void) | null;
  tryActive: boolean;
  stopMessageAnimation: (() => void) | null;
  onWaitingChange: ((waiting: boolean) => void) | null;
  onBackClick: (() => void) | null;
  onVideoClick: (() => void) | null;
  onReady: (() => void) | null;
  onSwitcherDone: (() => void) | null;
  onSwitcherOpen: (() => void) | null;
  switcherOpenFiredEarly: boolean;
  switcherDoneFiredEarly: boolean;
  switcherOpen: boolean;
  loginTitle: string | undefined;
  loginSubtitle: string | undefined;
  switcherPhase: SwitcherPhase;
  switcherProgress: number;
  switcherShiftProgress: number;
  switcherFinalProgress: number;
  chatDirty: boolean;
  botResponses: string[];
  botResponseIndex: number;
  backButtonRect: { x: number; y: number; w: number; h: number } | null;
  videoButtonPosition: { x: number; y: number } | null;
  backButtonElement: HTMLButtonElement | null;
  videoButtonElement: HTMLButtonElement | null;
  platform: string | undefined;
  cameraZoomDone: boolean;
  introDelay: number;
}

function createModelRuntime(): ModelRuntime {
  return {
    triggerSpin: null,
    triggerRestartMessages: null,
    triggerSendMessage: null,
    triggerSlideDown: null,
    invalidate: null,
    tryActive: false,
    stopMessageAnimation: null,
    onWaitingChange: null,
    onBackClick: null,
    onVideoClick: null,
    onReady: null,
    onSwitcherDone: null,
    onSwitcherOpen: null,
    switcherOpenFiredEarly: false,
    switcherDoneFiredEarly: false,
    switcherOpen: false,
    loginTitle: undefined,
    loginSubtitle: undefined,
    switcherPhase: "idle",
    switcherProgress: 0,
    switcherShiftProgress: 0,
    switcherFinalProgress: 0,
    chatDirty: true,
    botResponses: DEFAULT_BOT_RESPONSES,
    botResponseIndex: 0,
    backButtonRect: null,
    videoButtonPosition: null,
    backButtonElement: null,
    videoButtonElement: null,
    platform: undefined,
    cameraZoomDone: false,
    introDelay: 3000,
  };
}

const OVERLAY_SIZE = 44;

function syncButtonOverlays(runtime: ModelRuntime) {
  const backElement = runtime.backButtonElement;
  const videoElement = runtime.videoButtonElement;
  const show = runtime.cameraZoomDone;
  const isTelegram = (runtime.platform ?? "imessage") === "telegram";

  if (backElement) {
    const rect = runtime.backButtonRect;
    if (rect && show) {
      backElement.style.display = "block";
      backElement.style.transform = isTelegram
        ? `translate(${rect.x - 12}px, ${rect.y + 12}px)`
        : `translate(${rect.x}px, ${rect.y}px)`;
      backElement.style.width = `${rect.w}px`;
      backElement.style.height = `${rect.h}px`;
    } else {
      backElement.style.display = "none";
    }
  }

  if (!videoElement) return;
  const position = runtime.videoButtonPosition;
  if (position && show && runtime.switcherPhase === "idle" && !isTelegram) {
    videoElement.style.display = "block";
    videoElement.style.transform = `translate(${position.x - OVERLAY_SIZE / 2}px, ${position.y - OVERLAY_SIZE / 2}px)`;
  } else {
    videoElement.style.display = "none";
  }
}

function configurePhoneLoader(loader: GLTFLoader) {
  loader.setMeshoptDecoder(MeshoptDecoder);
}

/**
 * Captures the three reflection cards once and assigns the resulting cubemap
 * to the phone scene. Keeping this small environment local avoids shipping the
 * HDR, EXR, gain-map, and Draco loaders required by general-purpose helpers.
 */
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

/** Find the 3D local-space position on a mesh for a given UV coordinate. */
function uvToMeshLocal(
  mesh: THREE.Mesh,
  targetU: number,
  targetV: number,
): THREE.Vector3 | null {
  const geo = mesh.geometry;
  const posAttr = geo.getAttribute("position");
  const uvAttr = geo.getAttribute("uv");
  const index = geo.getIndex();
  if (!posAttr || !uvAttr) return null;

  const triCount = index ? index.count / 3 : posAttr.count / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

    const u0 = uvAttr.getX(i0),
      v0 = uvAttr.getY(i0);
    const u1 = uvAttr.getX(i1),
      v1 = uvAttr.getY(i1);
    const u2 = uvAttr.getX(i2),
      v2 = uvAttr.getY(i2);

    const denom = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(denom) < 1e-10) continue;

    const a = ((v1 - v2) * (targetU - u2) + (u2 - u1) * (targetV - v2)) / denom;
    const b = ((v2 - v0) * (targetU - u2) + (u0 - u2) * (targetV - v2)) / denom;
    const c = 1 - a - b;

    if (a >= -0.01 && b >= -0.01 && c >= -0.01) {
      return new THREE.Vector3(
        a * posAttr.getX(i0) + b * posAttr.getX(i1) + c * posAttr.getX(i2),
        a * posAttr.getY(i0) + b * posAttr.getY(i1) + c * posAttr.getY(i2),
        a * posAttr.getZ(i0) + b * posAttr.getZ(i1) + c * posAttr.getZ(i2),
      );
    }
  }
  return null;
}

/** Project a mesh-local point to screen pixels via the camera. */
function projectToScreen(
  localPos: THREE.Vector3,
  mesh: THREE.Mesh,
  camera: THREE.Camera,
  size: { width: number; height: number },
): { x: number; y: number } | null {
  const pos = localPos.clone();
  mesh.localToWorld(pos);
  pos.project(camera);
  if (pos.z > 1) return null;
  return {
    x: (pos.x * 0.5 + 0.5) * size.width,
    y: (-pos.y * 0.5 + 0.5) * size.height,
  };
}

function Model({ runtime }: { runtime: ModelRuntime }) {
  const { scene: sourceScene } = useLoader(
    GLTFLoader,
    "/models/iphone-meshopt.glb",
    configurePhoneLoader,
  );
  const scene = useMemo(() => sourceScene.clone(true), [sourceScene]);
  const cumulative = useRef(0);
  const [target, setTarget] = useState(0);
  const [dipping, setDipping] = useState(false);
  const [slidingDown, setSlidingDown] = useState(false);
  const screenMeshRef = useRef<THREE.Mesh | null>(null);
  const backBtnTLRef = useRef<THREE.Vector3 | null>(null); // top-left of pill
  const backBtnBRRef = useRef<THREE.Vector3 | null>(null); // bottom-right of pill
  const vidBtnLocalRef = useRef<THREE.Vector3 | null>(null);
  const chatTextureRef = useRef<THREE.CanvasTexture | null>(null);
  const avatarImgRef = useRef<HTMLImageElement | null>(null);
  const msgCountRef = useRef(0);
  const scrollYRef = useRef(0);
  const msgTimeoutRef = useRef(0);
  const msgAnimFrameRef = useRef(0);
  const extraMessagesRef = useRef<ExtraMessage[]>([]);
  const sendAnimFrameRef = useRef(0);
  const extraScrollRef = useRef(0);
  const typingTimeoutRef = useRef(0);
  const responseTimeoutRef = useRef(0);
  const typingAnimFrameRef = useRef(0);
  const responseAnimFrameRef = useRef(0);
  const spinTimeoutRef = useRef(0);
  const invalidate = useThree((state) => state.invalidate);

  const { rotation } = useSpring({
    rotation: target,
    config: { mass: 2.1, tension: 91, friction: 14 },
  });

  const { dipZ } = useSpring({
    dipZ: dipping ? 2 : 0,
    config: dipping
      ? { mass: 1, tension: 180, friction: 16 }
      : { mass: 1, tension: 120, friction: 14 },
  });

  const { slideY } = useSpring({
    slideY: slidingDown ? 200 : 0,
    config: { mass: 1, tension: 120, friction: 20 },
  });

  useEffect(() => {
    runtime.invalidate = invalidate;
    return () => {
      runtime.invalidate = null;
    };
  }, [invalidate, runtime]);

  useEffect(() => {
    runtime.triggerSlideDown = () => setSlidingDown(true);
    runtime.triggerSpin = (direction: 1 | -1 = 1) => {
      cumulative.current += direction * Math.PI * 2;
      setTarget(cumulative.current);
      setDipping(true);
      clearTimeout(spinTimeoutRef.current);
      spinTimeoutRef.current = window.setTimeout(() => setDipping(false), 300);
    };
    return () => {
      runtime.triggerSlideDown = null;
      runtime.triggerSpin = null;
      clearTimeout(spinTimeoutRef.current);
    };
  }, [runtime]);

  useEffect(() => {
    const avatarImg = new Image();
    avatarImg.src = "/elizapfp.webp";
    let cancelled = false;
    let animFrame = 0;
    let initialized = false;

    const setup = () => {
      if (cancelled) return;
      initialized = true;
      const startOffset = -14;
      const chatTexture = new THREE.CanvasTexture(
        renderChatToCanvas(undefined, 0, avatarImg, 1, startOffset),
      );
      chatTexture.flipY = false;
      chatTexture.colorSpace = THREE.SRGBColorSpace;
      chatTextureRef.current = chatTexture;
      avatarImgRef.current = avatarImg;

      scene.traverse((child: THREE.Object3D) => {
        if (!(child instanceof THREE.Mesh)) return;
        const name = child.name.toLowerCase();

        if (name.includes("screen")) {
          screenMeshRef.current = child;
          child.material = new THREE.MeshBasicMaterial({ map: chatTexture });

          const backTL = uvToMeshLocal(
            child,
            BACK_BTN_X / CANVAS_W,
            (BACK_BTN_CY - BACK_BTN_H / 2) / CANVAS_H,
          );
          const backBR = uvToMeshLocal(
            child,
            (BACK_BTN_X + BACK_BTN_W_ESTIMATE) / CANVAS_W,
            (BACK_BTN_CY + BACK_BTN_H / 2) / CANVAS_H,
          );
          if (backTL) backBtnTLRef.current = backTL;
          if (backBR) backBtnBRRef.current = backBR;

          const vidPos = uvToMeshLocal(
            child,
            VID_BTN_CX / CANVAS_W,
            VID_BTN_CY / CANVAS_H,
          );
          if (vidPos) vidBtnLocalRef.current = vidPos;
        } else if (name.includes("island")) {
          child.material = new THREE.MeshPhysicalMaterial({
            color: 0x000000,
            metalness: 1,
            roughness: 0,
            clearcoat: 0.6,
            clearcoatRoughness: 0.05,
            reflectivity: 1.0,
          });
        } else if (name.includes("camera")) {
          child.material = new THREE.MeshPhysicalMaterial({
            color: 0x000000,
            metalness: 0.2,
            roughness: 0,
            clearcoat: 1.0,
            clearcoatRoughness: 0,
            reflectivity: 1.0,
          });
        } else if (name.includes("flash")) {
          child.material = new THREE.MeshPhysicalMaterial({
            color: 0x444444,
            metalness: 0.2,
            roughness: 0,
            clearcoat: 1.0,
            clearcoatRoughness: 0,
            reflectivity: 1.0,
          });
        } else if (name.includes("iphone") || name.includes("phone")) {
          child.material = new THREE.MeshPhysicalMaterial({
            color: 0x444444,
            metalness: 0.35,
            roughness: 0.45,
            clearcoat: 0,
            clearcoatRoughness: 0.05,
            reflectivity: 1.0,
          });
        }
      });

      // Animate pfp sliding down during camera zoom (3s delay, ~1.7s animation)
      const offsetStart = performance.now() + runtime.introDelay;
      const offsetDuration = 1100;

      const animateOffset = (now: number) => {
        if (cancelled) return;
        if (now < offsetStart) {
          animFrame = requestAnimationFrame(animateOffset);
          return;
        }
        const elapsed = now - offsetStart;
        const t = Math.min(elapsed / offsetDuration, 1);
        const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
        const offset = startOffset * (1 - eased);

        chatTexture.image = renderChatToCanvas(
          chatTexture.image as HTMLCanvasElement,
          0,
          avatarImg,
          1,
          offset,
        );
        chatTexture.needsUpdate = true;
        invalidate();

        if (t < 1) {
          animFrame = requestAnimationFrame(animateOffset);
        }
      };

      animFrame = requestAnimationFrame(animateOffset);

      // Animate messages one by one with slide-up animation
      let count = 0;

      const startMessages = (delay: number) => {
        count = 0;
        msgCountRef.current = 0;

        const animateMessage = () => {
          count++;
          msgCountRef.current = count;
          if (count > getMessageCount() || cancelled || runtime.tryActive)
            return;

          const duration = 300;
          const startTime = performance.now();

          const tick = (now: number) => {
            if (cancelled) return;
            const elapsed = now - startTime;
            const t = Math.min(elapsed / duration, 1);
            const eased = 1 - (1 - t) ** 3;

            chatTexture.image = renderChatToCanvas(
              chatTexture.image as HTMLCanvasElement,
              count,
              avatarImg,
              eased,
            );
            chatTexture.needsUpdate = true;
            invalidate();

            if (t < 1) {
              msgAnimFrameRef.current = requestAnimationFrame(tick);
            } else if (count < getMessageCount() && !runtime.tryActive) {
              msgTimeoutRef.current = window.setTimeout(animateMessage, 700);
            }
          };

          msgAnimFrameRef.current = requestAnimationFrame(tick);
        };

        msgTimeoutRef.current = window.setTimeout(animateMessage, delay);
      };

      runtime.stopMessageAnimation = () => {
        clearTimeout(msgTimeoutRef.current);
        cancelAnimationFrame(msgAnimFrameRef.current);
      };

      runtime.triggerRestartMessages = () => {
        clearTimeout(msgTimeoutRef.current);
        cancelAnimationFrame(msgAnimFrameRef.current);
        cancelAnimationFrame(sendAnimFrameRef.current);
        clearTimeout(typingTimeoutRef.current);
        clearTimeout(responseTimeoutRef.current);
        cancelAnimationFrame(typingAnimFrameRef.current);
        cancelAnimationFrame(responseAnimFrameRef.current);
        runtime.onWaitingChange?.(false);
        count = 0;
        msgCountRef.current = 0;
        extraMessagesRef.current = [];
        extraScrollRef.current = 0;
        chatTexture.image = renderChatToCanvas(
          chatTexture.image as HTMLCanvasElement,
          0,
          avatarImg,
          1,
        );
        chatTexture.needsUpdate = true;
        invalidate();
        startMessages(500);
      };

      runtime.triggerSendMessage = (text: string) => {
        const msg: ExtraMessage = { text, progress: 0, from: "user" };
        extraMessagesRef.current = [...extraMessagesRef.current, msg];
        extraScrollRef.current += measureBubbleHeight(text);
        const duration = 300;
        const startTime = performance.now();

        const tick = (now: number) => {
          const elapsed = now - startTime;
          const t = Math.min(elapsed / duration, 1);
          msg.progress = 1 - (1 - t) ** 3;

          chatTexture.image = renderChatToCanvas(
            chatTexture.image as HTMLCanvasElement,
            msgCountRef.current,
            avatarImg,
            1,
            0,
            scrollYRef.current,
            extraMessagesRef.current,
          );
          chatTexture.needsUpdate = true;
          invalidate();

          if (t < 1) {
            sendAnimFrameRef.current = requestAnimationFrame(tick);
          }
        };

        sendAnimFrameRef.current = requestAnimationFrame(tick);

        // Set waiting state
        runtime.onWaitingChange?.(true);

        // After 500ms, show typing indicator
        typingTimeoutRef.current = window.setTimeout(() => {
          const typingMsg: ExtraMessage = {
            text: "",
            progress: 0,
            from: "bot",
            typing: true,
          };
          extraMessagesRef.current = [...extraMessagesRef.current, typingMsg];
          extraScrollRef.current += TYPING_BUBBLE_HEIGHT;

          const dur = 300;
          const start = performance.now();
          const animTyping = (now: number) => {
            const elapsed = now - start;
            const t = Math.min(elapsed / dur, 1);
            typingMsg.progress = 1 - (1 - t) ** 3;
            chatTexture.image = renderChatToCanvas(
              chatTexture.image as HTMLCanvasElement,
              msgCountRef.current,
              avatarImg,
              1,
              0,
              scrollYRef.current,
              extraMessagesRef.current,
            );
            chatTexture.needsUpdate = true;
            invalidate();
            if (t < 1)
              typingAnimFrameRef.current = requestAnimationFrame(animTyping);
          };
          typingAnimFrameRef.current = requestAnimationFrame(animTyping);

          // After 2s, replace typing with bot response
          responseTimeoutRef.current = window.setTimeout(() => {
            extraMessagesRef.current = extraMessagesRef.current.filter(
              (m) => !m.typing,
            );
            extraScrollRef.current -= TYPING_BUBBLE_HEIGHT;

            const response =
              runtime.botResponses[
                runtime.botResponseIndex % runtime.botResponses.length
              ];
            runtime.botResponseIndex++;
            const responseMsg: ExtraMessage = {
              text: response,
              progress: 0,
              from: "bot",
            };
            extraMessagesRef.current = [
              ...extraMessagesRef.current,
              responseMsg,
            ];
            extraScrollRef.current += measureBubbleHeight(response);

            const dur2 = 300;
            const start2 = performance.now();
            const animResponse = (now: number) => {
              const elapsed = now - start2;
              const t = Math.min(elapsed / dur2, 1);
              responseMsg.progress = 1 - (1 - t) ** 3;
              chatTexture.image = renderChatToCanvas(
                chatTexture.image as HTMLCanvasElement,
                msgCountRef.current,
                avatarImg,
                1,
                0,
                scrollYRef.current,
                extraMessagesRef.current,
              );
              chatTexture.needsUpdate = true;
              invalidate();
              if (t < 1) {
                responseAnimFrameRef.current =
                  requestAnimationFrame(animResponse);
              } else {
                runtime.onWaitingChange?.(false);
              }
            };
            responseAnimFrameRef.current = requestAnimationFrame(animResponse);
          }, 1400);
        }, 400);
      };

      startMessages(runtime.introDelay + 1600);
    };

    if (avatarImg.complete) {
      setup();
    } else {
      avatarImg.onload = () => setup();
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(animFrame);
      clearTimeout(spinTimeoutRef.current);
      clearTimeout(msgTimeoutRef.current);
      clearTimeout(typingTimeoutRef.current);
      clearTimeout(responseTimeoutRef.current);
      cancelAnimationFrame(msgAnimFrameRef.current);
      cancelAnimationFrame(sendAnimFrameRef.current);
      cancelAnimationFrame(typingAnimFrameRef.current);
      cancelAnimationFrame(responseAnimFrameRef.current);
      runtime.triggerRestartMessages = null;
      runtime.triggerSendMessage = null;
      runtime.stopMessageAnimation = null;
      if (initialized) {
        scene.traverse((child: THREE.Object3D) => {
          if (!(child instanceof THREE.Mesh)) return;
          const materials = Array.isArray(child.material)
            ? child.material
            : [child.material];
          for (const material of materials) material.dispose();
        });
        chatTextureRef.current?.dispose();
      }
    };
  }, [runtime, scene, invalidate]);

  // Animate scroll when tryActive changes + continuous render for typing dots + switcher
  useFrame(({ camera, size, invalidate: scheduleFrame }, delta) => {
    // Project button 3D positions → screen pixels
    if (screenMeshRef.current) {
      const mesh = screenMeshRef.current;
      if (backBtnTLRef.current && backBtnBRRef.current) {
        const tl = projectToScreen(backBtnTLRef.current, mesh, camera, size);
        const br = projectToScreen(backBtnBRRef.current, mesh, camera, size);
        if (tl && br) {
          runtime.backButtonRect = {
            x: Math.min(tl.x, br.x),
            y: Math.min(tl.y, br.y),
            w: Math.abs(br.x - tl.x),
            h: Math.abs(br.y - tl.y),
          };
        } else {
          runtime.backButtonRect = null;
        }
      }
      if (vidBtnLocalRef.current) {
        runtime.videoButtonPosition = projectToScreen(
          vidBtnLocalRef.current,
          mesh,
          camera,
          size,
        );
      }
    }

    const lerpSpeed = Math.min(delta * 8, 1);
    const THRESH = 0.001;

    // State transitions
    if (runtime.switcherOpen && runtime.switcherPhase === "idle") {
      runtime.switcherPhase = "opening";
      runtime.switcherProgress = 0;
      runtime.switcherShiftProgress = 0;
      runtime.switcherFinalProgress = 0;
      runtime.switcherOpenFiredEarly = false;
    }
    if (!runtime.switcherOpen && runtime.switcherPhase === "open") {
      runtime.switcherPhase = "closing";
      runtime.switcherProgress = 0;
      runtime.switcherShiftProgress = 0;
      runtime.switcherFinalProgress = 0;
      runtime.switcherDoneFiredEarly = false;
    }

    // Same 3-phase forward animation for both opening and closing
    if (
      runtime.switcherPhase === "opening" ||
      runtime.switcherPhase === "closing"
    ) {
      // Phase 1: scale
      const scaleDiff = 1 - runtime.switcherProgress;
      if (Math.abs(scaleDiff) > THRESH) {
        runtime.switcherProgress += scaleDiff * lerpSpeed;
      } else {
        runtime.switcherProgress = 1;
      }
      // Phase 2: shift — starts once scale done
      if (runtime.switcherProgress > 0.99) {
        const shiftDiff = 1 - runtime.switcherShiftProgress;
        if (Math.abs(shiftDiff) > THRESH) {
          runtime.switcherShiftProgress += shiftDiff * lerpSpeed;
        } else {
          runtime.switcherShiftProgress = 1;
        }
      }
      // Phase 3: final — starts once shift done
      if (runtime.switcherShiftProgress > 0.99) {
        const finalDiff = 1 - runtime.switcherFinalProgress;
        if (Math.abs(finalDiff) > THRESH) {
          runtime.switcherFinalProgress += finalDiff * lerpSpeed;
        } else {
          runtime.switcherFinalProgress = 1;
        }
      }
      // Fire callbacks early so UI bars start appearing sooner
      if (runtime.switcherFinalProgress > 0.8) {
        if (
          runtime.switcherPhase === "opening" &&
          !runtime.switcherOpenFiredEarly
        ) {
          runtime.switcherOpenFiredEarly = true;
          runtime.onSwitcherOpen?.();
        }
        if (
          runtime.switcherPhase === "closing" &&
          !runtime.switcherDoneFiredEarly
        ) {
          runtime.switcherDoneFiredEarly = true;
          runtime.onSwitcherDone?.();
        }
      }
      // Check completion
      if (runtime.switcherFinalProgress > 0.99) {
        if (runtime.switcherPhase === "opening") {
          runtime.switcherPhase = "open";
        } else {
          // closing done — back to idle
          runtime.switcherPhase = "idle";
          runtime.switcherProgress = 0;
          runtime.switcherShiftProgress = 0;
          runtime.switcherFinalProgress = 0;
        }
        runtime.chatDirty = true;
      }
    }

    const switcherAnimating =
      runtime.switcherPhase === "opening" ||
      runtime.switcherPhase === "closing";
    const switcherReversed = runtime.switcherPhase === "closing";

    const hasTyping = extraMessagesRef.current.some((m) => m.typing);
    const preloadScroll = measurePreloadedScrollHeight(msgCountRef.current);
    const initialScroll = preloadScroll > 27 ? preloadScroll - 27 : 0;
    const goal = runtime.tryActive ? initialScroll + extraScrollRef.current : 0;
    const current = scrollYRef.current;
    const needsScroll = Math.abs(current - goal) >= 0.1;

    if (needsScroll) {
      scrollYRef.current += (goal - current) * Math.min(delta * 6, 1);
    } else if (scrollYRef.current !== goal) {
      scrollYRef.current = goal;
    }

    if (
      needsScroll ||
      scrollYRef.current !== current ||
      hasTyping ||
      switcherAnimating ||
      runtime.chatDirty
    ) {
      if (chatTextureRef.current && avatarImgRef.current) {
        chatTextureRef.current.image = renderChatToCanvas(
          chatTextureRef.current.image as HTMLCanvasElement,
          msgCountRef.current,
          avatarImgRef.current,
          1,
          0,
          scrollYRef.current,
          extraMessagesRef.current,
          runtime.switcherProgress,
          runtime.switcherShiftProgress,
          runtime.switcherFinalProgress,
          switcherReversed,
          runtime.loginTitle,
          runtime.loginSubtitle,
        );
        chatTextureRef.current.needsUpdate = true;
        runtime.chatDirty = false;
      }
    }

    syncButtonOverlays(runtime);

    if (needsScroll || hasTyping || switcherAnimating) {
      scheduleFrame();
    }
  });

  return (
    <animated.group
      rotation-z={rotation}
      position-z={dipZ}
      position-y={slideY.to((y) => -y)}
    >
      <primitive object={scene} position={[0, 0, 3.6]} />
    </animated.group>
  );
}

useLoader.preload(
  GLTFLoader,
  "/models/iphone-meshopt.glb",
  configurePhoneLoader,
);

function FovZoom({ runtime }: { runtime: ModelRuntime }) {
  const startFov = 2.8;
  const endFov = 90;
  const startY = 19.5;
  const endY = 8;
  const progress = useRef(0);
  const initialized = useRef(false);
  const started = useRef(false);
  const completed = useRef(false);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      started.current = true;
      invalidate();
    }, runtime.introDelay);
    return () => window.clearTimeout(timeout);
  }, [invalidate, runtime]);

  useFrame((state, delta) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    if (!initialized.current) {
      cam.fov = startFov;
      cam.position.y = startY;
      cam.updateProjectionMatrix();
      initialized.current = true;
    }
    if (!started.current) return;
    if (progress.current >= 1) {
      if (!completed.current) {
        completed.current = true;
        runtime.cameraZoomDone = true;
        runtime.onReady?.();
        state.invalidate();
      }
      return;
    }
    progress.current = Math.min(progress.current + delta * 0.9, 1);
    const p = progress.current;
    const t = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    cam.fov = startFov + (endFov - startFov) * t;
    cam.position.y = startY + (endY - startY) * t;
    cam.updateProjectionMatrix();
    state.invalidate();
  });

  return null;
}

const ModelB = forwardRef<ModelBHandle, ModelBProps>(function ModelB(
  {
    tryActive = false,
    switcherOpen = false,
    onWaitingChange,
    onBackClick,
    onVideoClick,
    onReady,
    onSwitcherDone,
    onSwitcherOpen,
    loginTitle,
    loginSubtitle,
    platform,
    introDelayMs,
  },
  ref,
) {
  const t = useT();
  const runtime = useMemo(createModelRuntime, []);
  runtime.introDelay = introDelayMs ?? 3000;
  const backBtnOverlayRef = useRef<HTMLButtonElement>(null);
  const vidBtnOverlayRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    runtime.tryActive = tryActive;
    runtime.chatDirty = true;
    if (tryActive) {
      runtime.stopMessageAnimation?.();
    }
    runtime.invalidate?.();
  }, [runtime, tryActive]);

  useEffect(() => {
    runtime.onWaitingChange = onWaitingChange ?? null;
  }, [onWaitingChange, runtime]);

  useEffect(() => {
    runtime.onBackClick = onBackClick ?? null;
  }, [onBackClick, runtime]);

  useEffect(() => {
    runtime.switcherOpen = switcherOpen;
    runtime.chatDirty = true;
    runtime.invalidate?.();
  }, [runtime, switcherOpen]);

  useEffect(() => {
    runtime.loginTitle = loginTitle;
    runtime.chatDirty = true;
    runtime.invalidate?.();
  }, [loginTitle, runtime]);

  useEffect(() => {
    runtime.loginSubtitle = loginSubtitle;
    runtime.chatDirty = true;
    runtime.invalidate?.();
  }, [loginSubtitle, runtime]);

  useEffect(() => {
    runtime.botResponses = DEFAULT_BOT_RESPONSES.map((defaultValue, i) =>
      t(`homepage_eliza.model.botResponse${i}`, { defaultValue }),
    );
  }, [runtime, t]);

  useEffect(() => {
    runtime.platform = platform;
    runtime.chatDirty = true;
    if (platform && platform !== "try") {
      setChatPlatform(platform);
    }
    runtime.invalidate?.();
  }, [platform, runtime]);

  useEffect(() => {
    runtime.onVideoClick = onVideoClick ?? null;
  }, [onVideoClick, runtime]);

  useEffect(() => {
    runtime.onReady = onReady ?? null;
  }, [onReady, runtime]);

  useEffect(() => {
    runtime.onSwitcherOpen = onSwitcherOpen ?? null;
  }, [onSwitcherOpen, runtime]);

  useEffect(() => {
    runtime.onSwitcherDone = onSwitcherDone ?? null;
  }, [onSwitcherDone, runtime]);

  useEffect(() => {
    runtime.backButtonElement = backBtnOverlayRef.current;
    runtime.videoButtonElement = vidBtnOverlayRef.current;
    return () => {
      runtime.backButtonElement = null;
      runtime.videoButtonElement = null;
    };
  }, [runtime]);

  useImperativeHandle(ref, () => ({
    spin(direction: 1 | -1 = 1) {
      runtime.triggerSpin?.(direction);
    },
    restartMessages() {
      runtime.triggerRestartMessages?.();
    },
    sendMessage(text: string) {
      runtime.triggerSendMessage?.(text);
    },
    slideDown() {
      runtime.triggerSlideDown?.();
    },
  }));

  return (
    <div className="fixed inset-0">
      <Canvas
        camera={{ position: [0, 8, 0.6], fov: 45 }}
        dpr={[1, 1.5]}
        frameloop="demand"
        gl={{
          alpha: true,
          powerPreference: "high-performance",
          toneMapping: THREE.NoToneMapping,
        }}
      >
        <ambientLight intensity={0.5} />
        <Model runtime={runtime} />
        <PhoneEnvironment />
        <FovZoom runtime={runtime} />
      </Canvas>
      {/* The invisible hit target follows its projected position in the phone canvas. */}
      <button
        type="button"
        ref={backBtnOverlayRef}
        onClick={() => {
          runtime.onBackClick?.();
        }}
        aria-label={t("homepage_eliza.model.backAria", {
          defaultValue: "Back",
        })}
        style={{
          display: "none",
          position: "fixed",
          top: 0,
          left: 0,
          border: "none",
          borderRadius: "9999px",
          background: "transparent",
          cursor: "pointer",
          padding: 0,
          zIndex: 25,
        }}
      />
      {/* The 3D screen needs a real DOM button to remain keyboard-accessible. */}
      <button
        type="button"
        ref={vidBtnOverlayRef}
        onClick={() => {
          runtime.onVideoClick?.();
        }}
        aria-label={t("homepage_eliza.model.videoAria", {
          defaultValue: "Open video call",
        })}
        style={{
          display: "none",
          position: "fixed",
          top: 0,
          left: 0,
          width: OVERLAY_SIZE,
          height: OVERLAY_SIZE,
          border: "none",
          borderRadius: "50%",
          background: "transparent",
          cursor: "pointer",
          padding: 0,
          zIndex: 25,
        }}
      />
    </div>
  );
});

export default ModelB;
