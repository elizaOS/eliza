/**
 * SceneOverlayManager — manages holographic floating panels in the three.js scene.
 *
 * Creates billboard panels (chat, agent status, heartbeats) as textured
 * planes with emissive materials, plus additional chat-mirror panels
 * scattered around the scene to create the "floating screens with chat"
 * effect in the Matrix Construct environment.
 */

import * as THREE from "three";
import {
  type AgentStatusOverlay,
  type ChatOverlayMessage,
  renderChatPanel,
  renderHeartbeatsPanel,
  renderStatusPanel,
  type TriggerOverlay,
} from "./scene-overlay-renderer";

// -- Panel configuration ------------------------------------------------------

/** Canvas resolution multiplier for crisp text. */
const CANVAS_SCALE = 2;

interface PanelConfig {
  /** World-space position of the panel center. */
  position: THREE.Vector3;
  /** World-space size (width, height) of the panel quad. */
  size: [width: number, height: number];
  /** Canvas pixel dimensions before CANVAS_SCALE. */
  canvasSize: [width: number, height: number];
}

const CHAT_PANEL: PanelConfig = {
  position: new THREE.Vector3(-0.8, 1.3, 0.2),
  size: [1.0, 1.5],
  canvasSize: [360, 540],
};

const STATUS_PANEL: PanelConfig = {
  position: new THREE.Vector3(0.8, 1.6, 0.2),
  size: [0.9, 0.55],
  canvasSize: [360, 220],
};

const HEARTBEATS_PANEL: PanelConfig = {
  position: new THREE.Vector3(0.8, 0.9, 0.2),
  size: [0.9, 0.65],
  canvasSize: [360, 260],
};

/** Extra chat-mirror panels positioned among the floating screens. */
const CHAT_MIRROR_PANELS: PanelConfig[] = [
  {
    // Back-left screen
    position: new THREE.Vector3(-3.0, 1.7, -5.2),
    size: [1.6, 2.4],
    canvasSize: [320, 480],
  },
  {
    // Back-center screen
    position: new THREE.Vector3(0.6, 2.1, -5.8),
    size: [1.8, 2.6],
    canvasSize: [340, 500],
  },
  {
    // Right side screen
    position: new THREE.Vector3(3.6, 1.4, -5.0),
    size: [1.4, 2.0],
    canvasSize: [300, 440],
  },
];

// -- OverlayPanel helper ------------------------------------------------------

interface OverlayPanel {
  group: THREE.Group;
  mesh: THREE.Mesh;
  glowMesh: THREE.Mesh;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  dirty: boolean;
  /** Current opacity for fade-in animation. */
  opacity: number;
  /** Target opacity (1 when data present, 0 when empty). */
  targetOpacity: number;
}

function createPanel(config: PanelConfig): OverlayPanel {
  const [cw, ch] = config.canvasSize;
  const scaledW = cw * CANVAS_SCALE;
  const scaledH = ch * CANVAS_SCALE;

  const canvas = document.createElement("canvas");
  canvas.width = scaledW;
  canvas.height = scaledH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get 2D context for overlay panel");

  ctx.scale(CANVAS_SCALE, CANVAS_SCALE);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;

  const [w, h] = config.size;

  const geometry = new THREE.PlaneGeometry(w, h);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);

  // Subtle glow plane behind the panel — soft blue for construct theme
  const glowGeometry = new THREE.PlaneGeometry(w * 1.08, h * 1.08);
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0x6a9fd8),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
  glowMesh.position.z = -0.01;

  const group = new THREE.Group();
  group.name = "OverlayPanel";
  group.position.copy(config.position);
  group.add(glowMesh);
  group.add(mesh);

  return {
    group,
    mesh,
    glowMesh,
    canvas,
    ctx,
    texture,
    dirty: true,
    opacity: 0,
    targetOpacity: 0,
  };
}

function disposePanel(panel: OverlayPanel): void {
  const mat = panel.mesh.material as THREE.MeshBasicMaterial;
  mat.map?.dispose();
  mat.dispose();
  panel.mesh.geometry.dispose();

  const glowMat = panel.glowMesh.material as THREE.MeshBasicMaterial;
  glowMat.dispose();
  panel.glowMesh.geometry.dispose();

  panel.texture.dispose();
  panel.group.removeFromParent();
}

// -- JSON-stable shallow comparison -------------------------------------------

function shallowArrayEquals<T>(a: T[], b: T[], keys: (keyof T)[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    for (const key of keys) {
      if (a[i]?.[key] !== b[i]?.[key]) return false;
    }
  }
  return true;
}

// -- SceneOverlayManager -----------------------------------------------------

export class SceneOverlayManager {
  private chatPanel: OverlayPanel;
  private statusPanel: OverlayPanel;
  private heartbeatsPanel: OverlayPanel;
  private chatMirrorPanels: OverlayPanel[] = [];
  private attached = false;
  private disposed = false;

  // Data snapshots for dirty checking
  private chatData: ChatOverlayMessage[] = [];
  private statusData: AgentStatusOverlay | null = null;
  private heartbeatsData: TriggerOverlay[] = [];

  private fontsChecked = false;

  constructor() {
    this.chatPanel = createPanel(CHAT_PANEL);
    this.statusPanel = createPanel(STATUS_PANEL);
    this.heartbeatsPanel = createPanel(HEARTBEATS_PANEL);

    // Create chat-mirror panels that echo the conversation onto distant screens
    for (const config of CHAT_MIRROR_PANELS) {
      this.chatMirrorPanels.push(createPanel(config));
    }
  }

  /** Add panel groups to the scene. Called once when the engine is ready. */
  attach(scene: THREE.Scene): void {
    if (this.attached || this.disposed) return;
    scene.add(this.chatPanel.group);
    scene.add(this.statusPanel.group);
    scene.add(this.heartbeatsPanel.group);
    for (const mirror of this.chatMirrorPanels) {
      scene.add(mirror.group);
    }
    this.attached = true;
  }

  /**
   * Per-frame update: billboard panels toward camera, animate opacity,
   * and repaint dirty canvases.
   */
  update(camera: THREE.PerspectiveCamera, delta: number): void {
    if (this.disposed || !this.attached) return;

    // Lazy font check
    if (!this.fontsChecked) {
      this.fontsChecked = true;
      void document.fonts.ready.then(() => {
        if (this.disposed) return;
        this.chatPanel.dirty = true;
        this.statusPanel.dirty = true;
        this.heartbeatsPanel.dirty = true;
        for (const mirror of this.chatMirrorPanels) {
          mirror.dirty = true;
        }
      });
    }

    this.updatePanel(this.chatPanel, camera, delta);
    this.updatePanel(this.statusPanel, camera, delta);
    this.updatePanel(this.heartbeatsPanel, camera, delta);
    for (const mirror of this.chatMirrorPanels) {
      this.updatePanel(mirror, camera, delta);
    }

    // Repaint dirty canvases
    if (this.chatPanel.dirty) {
      this.chatPanel.dirty = false;
      this.chatPanel.ctx.save();
      this.chatPanel.ctx.setTransform(CANVAS_SCALE, 0, 0, CANVAS_SCALE, 0, 0);
      renderChatPanel(
        this.chatPanel.ctx,
        CHAT_PANEL.canvasSize[0],
        CHAT_PANEL.canvasSize[1],
        this.chatData,
      );
      this.chatPanel.ctx.restore();
      this.chatPanel.texture.needsUpdate = true;
    }

    if (this.statusPanel.dirty) {
      this.statusPanel.dirty = false;
      this.statusPanel.ctx.save();
      this.statusPanel.ctx.setTransform(CANVAS_SCALE, 0, 0, CANVAS_SCALE, 0, 0);
      renderStatusPanel(
        this.statusPanel.ctx,
        STATUS_PANEL.canvasSize[0],
        STATUS_PANEL.canvasSize[1],
        this.statusData,
      );
      this.statusPanel.ctx.restore();
      this.statusPanel.texture.needsUpdate = true;
    }

    if (this.heartbeatsPanel.dirty) {
      this.heartbeatsPanel.dirty = false;
      this.heartbeatsPanel.ctx.save();
      this.heartbeatsPanel.ctx.setTransform(
        CANVAS_SCALE,
        0,
        0,
        CANVAS_SCALE,
        0,
        0,
      );
      renderHeartbeatsPanel(
        this.heartbeatsPanel.ctx,
        HEARTBEATS_PANEL.canvasSize[0],
        HEARTBEATS_PANEL.canvasSize[1],
        this.heartbeatsData,
      );
      this.heartbeatsPanel.ctx.restore();
      this.heartbeatsPanel.texture.needsUpdate = true;
    }

    // Repaint chat-mirror panels
    for (let i = 0; i < this.chatMirrorPanels.length; i++) {
      const mirror = this.chatMirrorPanels[i];
      if (mirror.dirty) {
        mirror.dirty = false;
        const config = CHAT_MIRROR_PANELS[i];
        mirror.ctx.save();
        mirror.ctx.setTransform(CANVAS_SCALE, 0, 0, CANVAS_SCALE, 0, 0);
        renderChatPanel(
          mirror.ctx,
          config.canvasSize[0],
          config.canvasSize[1],
          this.chatData,
        );
        mirror.ctx.restore();
        mirror.texture.needsUpdate = true;
      }
    }
  }

  // -- Data setters -----------------------------------------------------------

  setChatMessages(messages: ChatOverlayMessage[]): void {
    if (this.disposed) return;
    if (shallowArrayEquals(this.chatData, messages, ["id", "role", "text"])) {
      return;
    }
    this.chatData = messages.map((m) => ({ ...m }));
    this.chatPanel.dirty = true;
    this.chatPanel.targetOpacity = 1;

    // Mark all chat-mirror panels dirty too
    for (const mirror of this.chatMirrorPanels) {
      mirror.dirty = true;
      mirror.targetOpacity = 1;
    }
  }

  setAgentStatus(status: AgentStatusOverlay | null): void {
    if (this.disposed) return;
    const prev = this.statusData;
    if (
      prev?.state === status?.state &&
      prev?.agentName === status?.agentName &&
      prev?.uptime === status?.uptime &&
      prev?.sessions.length === (status?.sessions.length ?? 0)
    ) {
      return;
    }
    this.statusData = status
      ? { ...status, sessions: status.sessions.map((s) => ({ ...s })) }
      : null;
    this.statusPanel.dirty = true;
    this.statusPanel.targetOpacity = status ? 1 : 0;
  }

  setHeartbeats(triggers: TriggerOverlay[]): void {
    if (this.disposed) return;
    if (
      shallowArrayEquals(this.heartbeatsData, triggers, [
        "id",
        "enabled",
        "lastStatus",
      ])
    ) {
      return;
    }
    this.heartbeatsData = triggers.map((t) => ({ ...t }));
    this.heartbeatsPanel.dirty = true;
    this.heartbeatsPanel.targetOpacity = triggers.length > 0 ? 1 : 0;
  }

  // -- Cleanup ----------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    disposePanel(this.chatPanel);
    disposePanel(this.statusPanel);
    disposePanel(this.heartbeatsPanel);
    for (const mirror of this.chatMirrorPanels) {
      disposePanel(mirror);
    }
    this.chatMirrorPanels = [];
  }

  // -- Internal ---------------------------------------------------------------

  private updatePanel(
    panel: OverlayPanel,
    camera: THREE.PerspectiveCamera,
    delta: number,
  ): void {
    // Billboard: make panel face the camera
    panel.group.quaternion.copy(camera.quaternion);

    // Animate opacity
    const fadeSpeed = 3.0;
    if (Math.abs(panel.opacity - panel.targetOpacity) > 0.001) {
      if (panel.opacity < panel.targetOpacity) {
        panel.opacity = Math.min(
          panel.targetOpacity,
          panel.opacity + delta * fadeSpeed,
        );
      } else {
        panel.opacity = Math.max(
          panel.targetOpacity,
          panel.opacity - delta * fadeSpeed,
        );
      }
      const mat = panel.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = panel.opacity * 0.92;

      const glowMat = panel.glowMesh.material as THREE.MeshBasicMaterial;
      glowMat.opacity = panel.opacity * 0.03;
    }

    panel.group.visible = panel.opacity > 0.001;
  }
}
