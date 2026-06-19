/**
 * MathEnvironment — Matrix Construct-style Three.js background scene.
 *
 * Light mode: white void with faint receding grid and translucent screen
 * panels — the loading construct from The Matrix.
 *
 * Dark mode: dark void with purple/neon-green grid and glowing screens
 * — cyberpunk matrix terminal aesthetic.
 *
 * No external models or textures — everything is procedural geometry.
 */

import * as THREE from "three";

const GRID_SIZE = 60;
const GRID_DIVISIONS = 60;
const GRID_Y = -0.75;

/** Screen panel definitions — distant ambient panels for visual depth. */
const SCREEN_DEFS: Array<{
  width: number;
  height: number;
  x: number;
  y: number;
  z: number;
  rotY?: number;
}> = [
  { width: 1.2, height: 0.75, x: -3.1, y: 2.2, z: -6.4 },
  { width: 1.25, height: 0.8, x: 2.9, y: 2.0, z: -6.8 },
  { width: 0.9, height: 0.55, x: -1.4, y: 3.0, z: -5.8, rotY: 0.12 },
  { width: 0.85, height: 0.52, x: 1.4, y: 3.1, z: -6.2, rotY: -0.12 },
];

const THEME_LIGHT = {
  fogColor: 0xf5f5f5,
  fogDensity: 0.045,
  gridColor: new THREE.Color(0.82, 0.84, 0.86),
  gridCenterColor: new THREE.Color(0.7, 0.75, 0.8),
  gridOpacity: 0.2,
  gridCenterOpacity: 0.25,
  screenEmissive: new THREE.Color(0.55, 0.75, 0.9),
  screenBaseColor: new THREE.Color(0.92, 0.94, 0.96),
  screenBorderColor: new THREE.Color(0.7, 0.72, 0.75),
  screenOpacity: 0.35,
  screenEmissiveIntensity: 0.25,
  scanBaseOpacity: 0.15,
  bgColor: 0xf5f5f5,
};

const THEME_DARK = {
  fogColor: 0x08060e,
  fogDensity: 0.035,
  gridColor: new THREE.Color(0.11, 0.08, 0.2),
  gridCenterColor: new THREE.Color(0.28, 0.19, 0.42),
  gridOpacity: 0.26,
  gridCenterOpacity: 0.34,
  screenEmissive: new THREE.Color(0.72, 0.52, 0.22),
  screenBaseColor: new THREE.Color(0.035, 0.03, 0.05),
  screenBorderColor: new THREE.Color(0.72, 0.54, 0.24),
  screenOpacity: 0.08,
  screenEmissiveIntensity: 0.16,
  scanBaseOpacity: 0.08,
  bgColor: 0x08060e,
};

type ThemeConfig = typeof THEME_LIGHT;

export class MathEnvironment {
  private group = new THREE.Group();
  private gridHelper: THREE.GridHelper | null = null;
  private gridMaterial: THREE.LineBasicMaterial | null = null;
  private gridCenterMaterial: THREE.LineBasicMaterial | null = null;
  private fog: THREE.FogExp2 | null = null;
  private screens: THREE.Mesh[] = [];
  private screenMaterials: THREE.MeshStandardMaterial[] = [];
  private borderMeshes: THREE.LineSegments[] = [];
  private borderMaterials: THREE.LineBasicMaterial[] = [];
  private scanLineMeshes: THREE.Mesh[] = [];
  private scanLineMaterials: THREE.MeshBasicMaterial[] = [];
  private elapsedTime = 0;
  private theme: "light" | "dark" = "dark";
  private sceneRef: THREE.Scene | null = null;

  /** Build and attach the environment to the given scene. */
  build(scene: THREE.Scene, theme: "light" | "dark"): void {
    this.theme = theme;
    this.sceneRef = scene;
    const config = theme === "light" ? THEME_LIGHT : THEME_DARK;

    this.group.name = "MathEnvironment";

    // White fog — everything fades to white at distance
    this.fog = new THREE.FogExp2(config.fogColor, config.fogDensity);
    scene.fog = this.fog;
    scene.background = new THREE.Color(config.bgColor);

    // Grid floor — faint in light mode, neon in dark mode
    this.gridMaterial = new THREE.LineBasicMaterial({
      color: config.gridColor,
      transparent: true,
      opacity: config.gridOpacity,
      depthWrite: false,
    });
    this.gridCenterMaterial = new THREE.LineBasicMaterial({
      color: config.gridCenterColor,
      transparent: true,
      opacity: config.gridCenterOpacity,
      depthWrite: false,
    });
    this.gridHelper = new THREE.GridHelper(
      GRID_SIZE,
      GRID_DIVISIONS,
      config.gridCenterColor,
      config.gridColor,
    );
    this.gridHelper.position.y = GRID_Y;
    const gridMats = this.gridHelper.material;
    if (Array.isArray(gridMats)) {
      for (const m of gridMats) {
        (m as THREE.LineBasicMaterial).transparent = true;
        (m as THREE.LineBasicMaterial).opacity = config.gridOpacity;
        (m as THREE.LineBasicMaterial).depthWrite = false;
      }
    }
    this.group.add(this.gridHelper);

    // Floating screen panels
    this.buildScreens(config);

    scene.add(this.group);
  }

  private buildScreens(config: ThemeConfig): void {
    for (const def of SCREEN_DEFS) {
      const geo = new THREE.PlaneGeometry(def.width, def.height);

      // Screen surface — slightly translucent, emissive glow
      const mat = new THREE.MeshStandardMaterial({
        color: config.screenBaseColor,
        emissive: config.screenEmissive,
        emissiveIntensity: config.screenEmissiveIntensity,
        transparent: true,
        opacity: config.screenOpacity,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this.screenMaterials.push(mat);

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(def.x, def.y, def.z);
      if (def.rotY != null) {
        mesh.rotation.y = def.rotY;
      } else {
        // Face toward origin
        mesh.lookAt(0, def.y, 0);
      }
      this.screens.push(mesh);
      this.group.add(mesh);

      // Thin border frame around each screen
      const edgeGeo = new THREE.EdgesGeometry(geo);
      const edgeMat = new THREE.LineBasicMaterial({
        color: config.screenBorderColor,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      });
      this.borderMaterials.push(edgeMat);
      const edgeMesh = new THREE.LineSegments(edgeGeo, edgeMat);
      edgeMesh.position.copy(mesh.position);
      edgeMesh.rotation.copy(mesh.rotation);
      edgeMesh.quaternion.copy(mesh.quaternion);
      this.borderMeshes.push(edgeMesh);
      this.group.add(edgeMesh);

      // Horizontal scan line sweeping across each screen
      const scanGeo = new THREE.PlaneGeometry(def.width * 0.92, 0.015);
      const scanMat = new THREE.MeshBasicMaterial({
        color: config.screenEmissive,
        transparent: true,
        opacity: 0.08,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.scanLineMaterials.push(scanMat);
      const scanMesh = new THREE.Mesh(scanGeo, scanMat);
      scanMesh.position.copy(mesh.position);
      scanMesh.quaternion.copy(mesh.quaternion);
      this.scanLineMeshes.push(scanMesh);
      this.group.add(scanMesh);
    }
  }

  /** Per-frame update — call from the render loop. */
  update(deltaTime: number, _camera: THREE.Camera): void {
    this.elapsedTime += deltaTime;
    const config = this.theme === "light" ? THEME_LIGHT : THEME_DARK;

    for (let i = 0; i < this.screens.length; i++) {
      const screen = this.screens[i];
      const def = SCREEN_DEFS[i];

      // Gentle float / bob
      screen.position.y =
        def.y + Math.sin(this.elapsedTime * 0.35 + i * 1.4) * 0.04;

      // Sync border position
      const border = this.borderMeshes[i];
      border.position.y = screen.position.y;

      // Emissive pulse — subtle in light, prominent neon glow in dark
      const mat = this.screenMaterials[i];
      const baseEmissive = config.screenEmissiveIntensity;
      const pulseRange = this.theme === "dark" ? 0.04 : 0.1;
      mat.emissiveIntensity =
        baseEmissive + Math.sin(this.elapsedTime * 0.6 + i * 0.8) * pulseRange;

      // Scan line sweeps vertically
      const scan = this.scanLineMeshes[i];
      const scanPhase = ((this.elapsedTime * 0.2 + i * 0.5) % 1.0) * 2.0 - 1.0;
      const upDir = new THREE.Vector3(0, 1, 0);
      scan.position.copy(screen.position);
      scan.position.addScaledVector(upDir, scanPhase * def.height * 0.45);
      const scanMat = this.scanLineMaterials[i];
      scanMat.opacity =
        config.scanBaseOpacity * (1.0 - Math.abs(scanPhase) * 0.5);
    }

    // Grid subtle pulse
    if (this.gridCenterMaterial) {
      const basePulse = config.gridCenterOpacity;
      this.gridCenterMaterial.opacity =
        basePulse + Math.sin(this.elapsedTime * 0.3) * 0.05;
    }
  }

  /** Switch theme without rebuilding. */
  setTheme(theme: "light" | "dark"): void {
    if (theme === this.theme) return;
    this.theme = theme;
    const config = theme === "light" ? THEME_LIGHT : THEME_DARK;

    if (this.fog) {
      this.fog.color.set(config.fogColor);
      this.fog.density = config.fogDensity;
    }
    if (this.sceneRef) {
      this.sceneRef.background = new THREE.Color(config.bgColor);
    }
    if (this.gridMaterial) {
      this.gridMaterial.color.copy(config.gridColor);
      this.gridMaterial.opacity = config.gridOpacity;
    }
    if (this.gridCenterMaterial) {
      this.gridCenterMaterial.color.copy(config.gridCenterColor);
      this.gridCenterMaterial.opacity = config.gridCenterOpacity;
    }
    if (this.gridHelper) {
      const gridMats = this.gridHelper.material;
      if (Array.isArray(gridMats)) {
        for (const m of gridMats) {
          (m as THREE.LineBasicMaterial).opacity = config.gridOpacity;
        }
      }
    }
    for (const mat of this.screenMaterials) {
      mat.color.copy(config.screenBaseColor);
      mat.emissive.copy(config.screenEmissive);
      mat.emissiveIntensity = config.screenEmissiveIntensity;
      mat.opacity = config.screenOpacity;
    }
    for (const mat of this.borderMaterials) {
      mat.color.copy(config.screenBorderColor);
    }
    for (const mat of this.scanLineMaterials) {
      mat.color.copy(config.screenEmissive);
    }
  }

  /** Dispose all Three.js objects. */
  dispose(): void {
    for (const mesh of this.screens) {
      mesh.geometry.dispose();
    }
    for (const mat of this.screenMaterials) {
      mat.dispose();
    }
    for (const mesh of this.borderMeshes) {
      mesh.geometry.dispose();
    }
    for (const mat of this.borderMaterials) {
      mat.dispose();
    }
    for (const mesh of this.scanLineMeshes) {
      mesh.geometry.dispose();
    }
    for (const mat of this.scanLineMaterials) {
      mat.dispose();
    }
    this.gridHelper?.geometry.dispose();
    this.gridMaterial?.dispose();
    this.gridCenterMaterial?.dispose();

    if (this.sceneRef) {
      this.sceneRef.remove(this.group);
      this.sceneRef.fog = null;
      this.sceneRef.background = null;
    }

    this.screens = [];
    this.screenMaterials = [];
    this.borderMeshes = [];
    this.borderMaterials = [];
    this.scanLineMeshes = [];
    this.scanLineMaterials = [];
    this.gridHelper = null;
    this.gridMaterial = null;
    this.gridCenterMaterial = null;
    this.fog = null;
    this.sceneRef = null;
  }
}
