import { animated, useSpring } from "@react-spring/three";
import { Environment, useGLTF } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
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

export interface ModelBHandle {
  spin: (direction?: 1 | -1) => void;
  restartMessages: () => void;
  sendMessage: (text: string) => void;
  slideDown: () => void;
}

export interface ModelBProps {
  tryActive?: boolean;
  switcherOpen?: boolean;
  onWaitingChange?: (waiting: boolean) => void;
  onBackClick?: () => void;
  onVideoClick?: () => void;
  onSwitcherDone?: () => void;
  onSwitcherOpen?: () => void;
  loginTitle?: string;
  loginSubtitle?: string;
  platform?: string;
  introDelayMs?: number;
}

let triggerSpin: ((direction: 1 | -1) => void) | null = null;
let triggerRestartMessages: (() => void) | null = null;
let triggerSendMessage: ((text: string) => void) | null = null;
let triggerSlideDown: (() => void) | null = null;
let currentTryActive = false;
let stopMessageAnimation: (() => void) | null = null;
let currentOnWaitingChange: ((waiting: boolean) => void) | null = null;
let currentOnBackClick: (() => void) | null = null;
let currentOnVideoClick: (() => void) | null = null;
let currentOnSwitcherDone: (() => void) | null = null;
let currentOnSwitcherOpen: (() => void) | null = null;
let switcherOpenFiredEarly = false;
let switcherDoneFiredEarly = false;
let currentSwitcherOpen = false;
let currentLoginTitle: string | undefined;
let currentLoginSubtitle: string | undefined;
let switcherPhase: "idle" | "opening" | "open" | "closing" = "idle";
let switcherProgress = 0;
let switcherShiftProgress = 0;
let switcherFinalProgress = 0;

const botResponses = [
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
let botResponseIndex = 0;
let backBtnScreenRect: { x: number; y: number; w: number; h: number } | null =
  null;
let vidBtnScreenPos: { x: number; y: number } | null = null;
let cameraZoomDone = false;
let introDelay = 3000;

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

function Model() {
  const { scene } = useGLTF("/models/iphone.glb");
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

  triggerSlideDown = () => {
    setSlidingDown(true);
  };

  triggerSpin = (direction: 1 | -1 = 1) => {
    cumulative.current += direction * Math.PI * 2;
    setTarget(cumulative.current);
    setDipping(true);
    setTimeout(() => setDipping(false), 300);
  };

  useEffect(() => {
    const avatarImg = new Image();
    avatarImg.src = "/elizapfp.png";
    let cancelled = false;
    const timeout = 0;
    let animFrame = 0;

    const setup = () => {
      const startOffset = -14;
      const chatTexture = new THREE.CanvasTexture(
        renderChatToCanvas(0, avatarImg, 1, startOffset),
      );
      chatTexture.flipY = false;
      chatTexture.colorSpace = THREE.SRGBColorSpace;
      chatTextureRef.current = chatTexture;
      avatarImgRef.current = avatarImg;

      scene.traverse((child) => {
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
            color: 0x222222,
            metalness: 0.6,
            roughness: 0.6,
            clearcoat: 0,
            clearcoatRoughness: 0.05,
            reflectivity: 1.0,
          });
        }
      });

      // Animate pfp sliding down during camera zoom (3s delay, ~1.7s animation)
      const offsetStart = performance.now() + introDelay;
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

        chatTexture.image = renderChatToCanvas(0, avatarImg, 1, offset);
        chatTexture.needsUpdate = true;

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
          if (count > getMessageCount() || cancelled || currentTryActive)
            return;

          const duration = 300;
          const startTime = performance.now();

          const tick = (now: number) => {
            if (cancelled) return;
            const elapsed = now - startTime;
            const t = Math.min(elapsed / duration, 1);
            const eased = 1 - (1 - t) ** 3;

            chatTexture.image = renderChatToCanvas(count, avatarImg, eased);
            chatTexture.needsUpdate = true;

            if (t < 1) {
              msgAnimFrameRef.current = requestAnimationFrame(tick);
            } else if (count < getMessageCount() && !currentTryActive) {
              msgTimeoutRef.current = window.setTimeout(animateMessage, 700);
            }
          };

          msgAnimFrameRef.current = requestAnimationFrame(tick);
        };

        msgTimeoutRef.current = window.setTimeout(animateMessage, delay);
      };

      stopMessageAnimation = () => {
        clearTimeout(msgTimeoutRef.current);
        cancelAnimationFrame(msgAnimFrameRef.current);
      };

      triggerRestartMessages = () => {
        clearTimeout(msgTimeoutRef.current);
        cancelAnimationFrame(msgAnimFrameRef.current);
        cancelAnimationFrame(sendAnimFrameRef.current);
        clearTimeout(typingTimeoutRef.current);
        clearTimeout(responseTimeoutRef.current);
        cancelAnimationFrame(typingAnimFrameRef.current);
        cancelAnimationFrame(responseAnimFrameRef.current);
        currentOnWaitingChange?.(false);
        count = 0;
        msgCountRef.current = 0;
        extraMessagesRef.current = [];
        extraScrollRef.current = 0;
        chatTexture.image = renderChatToCanvas(0, avatarImg, 1);
        chatTexture.needsUpdate = true;
        startMessages(500);
      };

      triggerSendMessage = (text: string) => {
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
            msgCountRef.current,
            avatarImg,
            1,
            0,
            scrollYRef.current,
            extraMessagesRef.current,
          );
          chatTexture.needsUpdate = true;

          if (t < 1) {
            sendAnimFrameRef.current = requestAnimationFrame(tick);
          }
        };

        sendAnimFrameRef.current = requestAnimationFrame(tick);

        // Set waiting state
        currentOnWaitingChange?.(true);

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
              msgCountRef.current,
              avatarImg,
              1,
              0,
              scrollYRef.current,
              extraMessagesRef.current,
            );
            chatTexture.needsUpdate = true;
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
              botResponses[botResponseIndex % botResponses.length];
            botResponseIndex++;
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
                msgCountRef.current,
                avatarImg,
                1,
                0,
                scrollYRef.current,
                extraMessagesRef.current,
              );
              chatTexture.needsUpdate = true;
              if (t < 1) {
                responseAnimFrameRef.current =
                  requestAnimationFrame(animResponse);
              } else {
                currentOnWaitingChange?.(false);
              }
            };
            responseAnimFrameRef.current = requestAnimationFrame(animResponse);
          }, 1400);
        }, 400);
      };

      startMessages(introDelay + 1600);
    };

    if (avatarImg.complete) {
      setup();
    } else {
      avatarImg.onload = () => setup();
    }

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      cancelAnimationFrame(animFrame);
    };
  }, [scene]);

  // Animate scroll when tryActive changes + continuous render for typing dots + switcher
  useFrame(({ camera, size }, delta) => {
    // Project button 3D positions → screen pixels
    if (screenMeshRef.current) {
      const mesh = screenMeshRef.current;
      if (backBtnTLRef.current && backBtnBRRef.current) {
        const tl = projectToScreen(backBtnTLRef.current, mesh, camera, size);
        const br = projectToScreen(backBtnBRRef.current, mesh, camera, size);
        if (tl && br) {
          backBtnScreenRect = {
            x: Math.min(tl.x, br.x),
            y: Math.min(tl.y, br.y),
            w: Math.abs(br.x - tl.x),
            h: Math.abs(br.y - tl.y),
          };
        } else {
          backBtnScreenRect = null;
        }
      }
      if (vidBtnLocalRef.current) {
        vidBtnScreenPos = projectToScreen(
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
    if (currentSwitcherOpen && switcherPhase === "idle") {
      switcherPhase = "opening";
      switcherProgress = 0;
      switcherShiftProgress = 0;
      switcherFinalProgress = 0;
      switcherOpenFiredEarly = false;
    }
    if (!currentSwitcherOpen && switcherPhase === "open") {
      switcherPhase = "closing";
      switcherProgress = 0;
      switcherShiftProgress = 0;
      switcherFinalProgress = 0;
      switcherDoneFiredEarly = false;
    }

    // Same 3-phase forward animation for both opening and closing
    if (switcherPhase === "opening" || switcherPhase === "closing") {
      // Phase 1: scale
      const scaleDiff = 1 - switcherProgress;
      if (Math.abs(scaleDiff) > THRESH) {
        switcherProgress += scaleDiff * lerpSpeed;
      } else {
        switcherProgress = 1;
      }
      // Phase 2: shift — starts once scale done
      if (switcherProgress > 0.99) {
        const shiftDiff = 1 - switcherShiftProgress;
        if (Math.abs(shiftDiff) > THRESH) {
          switcherShiftProgress += shiftDiff * lerpSpeed;
        } else {
          switcherShiftProgress = 1;
        }
      }
      // Phase 3: final — starts once shift done
      if (switcherShiftProgress > 0.99) {
        const finalDiff = 1 - switcherFinalProgress;
        if (Math.abs(finalDiff) > THRESH) {
          switcherFinalProgress += finalDiff * lerpSpeed;
        } else {
          switcherFinalProgress = 1;
        }
      }
      // Fire callbacks early so UI bars start appearing sooner
      if (switcherFinalProgress > 0.8) {
        if (switcherPhase === "opening" && !switcherOpenFiredEarly) {
          switcherOpenFiredEarly = true;
          currentOnSwitcherOpen?.();
        }
        if (switcherPhase === "closing" && !switcherDoneFiredEarly) {
          switcherDoneFiredEarly = true;
          currentOnSwitcherDone?.();
        }
      }
      // Check completion
      if (switcherFinalProgress > 0.99) {
        if (switcherPhase === "opening") {
          switcherPhase = "open";
        } else {
          // closing done — back to idle
          switcherPhase = "idle";
          switcherProgress = 0;
          switcherShiftProgress = 0;
          switcherFinalProgress = 0;
        }
      }
    }

    const switcherActive = switcherPhase !== "idle";
    const switcherAnimating =
      switcherPhase === "opening" || switcherPhase === "closing";
    const switcherReversed = switcherPhase === "closing";

    const hasTyping = extraMessagesRef.current.some((m) => m.typing);
    const preloadScroll = measurePreloadedScrollHeight(msgCountRef.current);
    const initialScroll = preloadScroll > 27 ? preloadScroll - 27 : 0;
    const goal = currentTryActive ? initialScroll + extraScrollRef.current : 0;
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
      switcherActive
    ) {
      if (chatTextureRef.current && avatarImgRef.current) {
        chatTextureRef.current.image = renderChatToCanvas(
          msgCountRef.current,
          avatarImgRef.current,
          1,
          0,
          scrollYRef.current,
          extraMessagesRef.current,
          switcherProgress,
          switcherShiftProgress,
          switcherFinalProgress,
          switcherReversed,
          currentLoginTitle,
          currentLoginSubtitle,
        );
        chatTextureRef.current.needsUpdate = true;
      }
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

useGLTF.preload("/models/iphone.glb");

function FovZoom() {
  const startFov = 2.8;
  const endFov = 90;
  const startY = 19.5;
  const endY = 8;
  const progress = useRef(0);
  const initialized = useRef(false);
  const elapsed = useRef(0);
  const delay = introDelay / 1000;

  useFrame((state, delta) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    if (!initialized.current) {
      cam.fov = startFov;
      cam.position.y = startY;
      cam.updateProjectionMatrix();
      initialized.current = true;
    }
    if (elapsed.current < delay) {
      elapsed.current += delta;
      return;
    }
    if (progress.current >= 1) {
      if (!cameraZoomDone) cameraZoomDone = true;
      return;
    }
    progress.current = Math.min(progress.current + delta * 0.9, 1);
    const p = progress.current;
    const t = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    cam.fov = startFov + (endFov - startFov) * t;
    cam.position.y = startY + (endY - startY) * t;
    cam.updateProjectionMatrix();
  });

  return null;
}

const OVERLAY_SIZE = 44;

const ModelB = forwardRef<ModelBHandle, ModelBProps>(function ModelB(
  {
    tryActive = false,
    switcherOpen = false,
    onWaitingChange,
    onBackClick,
    onVideoClick,
    onSwitcherDone,
    onSwitcherOpen,
    loginTitle,
    loginSubtitle,
    platform,
    introDelayMs,
  },
  ref,
) {
  const backBtnOverlayRef = useRef<HTMLDivElement>(null);
  const vidBtnOverlayRef = useRef<HTMLDivElement>(null);
  const platformRef = useRef(platform);

  useEffect(() => {
    currentTryActive = tryActive;
    if (tryActive) {
      stopMessageAnimation?.();
    }
  }, [tryActive]);

  useEffect(() => {
    currentOnWaitingChange = onWaitingChange ?? null;
  }, [onWaitingChange]);

  useEffect(() => {
    currentOnBackClick = onBackClick ?? null;
  }, [onBackClick]);

  useEffect(() => {
    currentSwitcherOpen = switcherOpen;
  }, [switcherOpen]);

  useEffect(() => {
    currentLoginTitle = loginTitle;
  }, [loginTitle]);

  useEffect(() => {
    currentLoginSubtitle = loginSubtitle;
  }, [loginSubtitle]);

  useEffect(() => {
    platformRef.current = platform;
    if (platform && platform !== "try") {
      setChatPlatform(platform);
    }
  }, [platform]);

  useEffect(() => {
    if (introDelayMs != null) introDelay = introDelayMs;
  }, [introDelayMs]);

  useEffect(() => {
    currentOnVideoClick = onVideoClick ?? null;
  }, [onVideoClick]);

  useEffect(() => {
    currentOnSwitcherOpen = onSwitcherOpen ?? null;
  }, [onSwitcherOpen]);

  useEffect(() => {
    currentOnSwitcherDone = onSwitcherDone ?? null;
  }, [onSwitcherDone]);

  // Sync overlay div positions every frame from projected 3D coords
  useEffect(() => {
    let raf: number;
    const update = () => {
      const backEl = backBtnOverlayRef.current;
      const vidEl = vidBtnOverlayRef.current;
      const show = cameraZoomDone;

      if (backEl) {
        if (backBtnScreenRect && show) {
          const plat = platformRef.current ?? "imessage";
          const isTG = plat === "telegram";
          backEl.style.display = "block";
          backEl.style.transform = isTG
            ? `translate(${backBtnScreenRect.x - 12}px, ${backBtnScreenRect.y + 12}px)`
            : `translate(${backBtnScreenRect.x}px, ${backBtnScreenRect.y}px)`;
          backEl.style.width = `${backBtnScreenRect.w}px`;
          backEl.style.height = `${backBtnScreenRect.h}px`;
          backEl.style.backgroundColor = "";
        } else {
          backEl.style.display = "none";
        }
      }
      if (vidEl) {
        const isTG = (platformRef.current ?? "imessage") === "telegram";
        if (vidBtnScreenPos && show && switcherPhase === "idle" && !isTG) {
          vidEl.style.display = "block";
          vidEl.style.transform = `translate(${vidBtnScreenPos.x - OVERLAY_SIZE / 2}px, ${vidBtnScreenPos.y - OVERLAY_SIZE / 2}px)`;
        } else {
          vidEl.style.display = "none";
        }
      }

      raf = requestAnimationFrame(update);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, []);

  useImperativeHandle(ref, () => ({
    spin(direction: 1 | -1 = 1) {
      triggerSpin?.(direction);
    },
    restartMessages() {
      triggerRestartMessages?.();
    },
    sendMessage(text: string) {
      triggerSendMessage?.(text);
    },
    slideDown() {
      triggerSlideDown?.();
    },
  }));

  return (
    <div className="fixed inset-0">
      <Canvas
        camera={{ position: [0, 8, 0.6], fov: 45 }}
        dpr={[1, 2]}
        gl={{ alpha: true, toneMapping: THREE.NoToneMapping }}
      >
        <ambientLight intensity={0.5} />
        <Model />
        <Environment preset="city" />
        <FovZoom />
      </Canvas>
      {/* Back button overlay — pill shaped, size set dynamically via rAF */}
      <div
        ref={backBtnOverlayRef}
        onClick={() => {
          currentOnBackClick?.();
        }}
        style={{
          display: "none",
          position: "fixed",
          top: 0,
          left: 0,
          borderRadius: "9999px",
          cursor: "pointer",
          zIndex: 25,
        }}
      />
      {/* Video button overlay */}
      <div
        ref={vidBtnOverlayRef}
        onClick={() => {
          currentOnVideoClick?.();
        }}
        style={{
          display: "none",
          position: "fixed",
          top: 0,
          left: 0,
          width: OVERLAY_SIZE,
          height: OVERLAY_SIZE,
          borderRadius: "50%",
          cursor: "pointer",
          zIndex: 25,
        }}
      />
    </div>
  );
});

export default ModelB;
