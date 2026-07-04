/**
 * Three.js AR overlay for aligning virtual scene objects with the robot camera
 * feed.
 *
 * The module consumes inverse homography and solvePnP pose estimates from the
 * tracking visualizer so rendered objects share the real camera projection.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

let scene, camera, renderer, controls, clock;
let mixer = null; // AnimationMixer for character
let walkAction = null; // walk AnimationAction
let idleAction = null; // idle AnimationAction
let characterGroup = null;
let characterLoaded = false;
let treeMeshTemplate = null;
let treesPlaced = false;
let sphereMesh = null;
let groundPlane = null;

let arEnabled = true;
let lastRobotPos = null;
const lastRobotHeading = 0;
let isWalking = false;

const loader = new GLTFLoader();

// ---- Camera pose from solvePnP ----
function setCameraFromPose(pose, camWidth, camHeight) {
  if (!pose || !camera) return;
  const { rvec, tvec, fx, fy, cx, cy } = pose;

  // Build rotation matrix from rvec (Rodrigues)
  const theta = Math.sqrt(rvec[0] ** 2 + rvec[1] ** 2 + rvec[2] ** 2);
  const R = new THREE.Matrix3();
  if (theta < 1e-6) {
    R.identity();
  } else {
    const k = [rvec[0] / theta, rvec[1] / theta, rvec[2] / theta];
    const ct = Math.cos(theta),
      st = Math.sin(theta),
      v = 1 - ct;
    R.set(
      ct + k[0] * k[0] * v,
      k[0] * k[1] * v - k[2] * st,
      k[0] * k[2] * v + k[1] * st,
      k[1] * k[0] * v + k[2] * st,
      ct + k[1] * k[1] * v,
      k[1] * k[2] * v - k[0] * st,
      k[2] * k[0] * v - k[1] * st,
      k[2] * k[1] * v + k[0] * st,
      ct + k[2] * k[2] * v,
    );
  }

  // solvePnP gives world-to-camera: P_cam = R * P_world + t
  // Camera position in world = -R^T * t
  const Re = R.elements; // column-major
  const Rt = new THREE.Matrix3();
  Rt.set(Re[0], Re[1], Re[2], Re[3], Re[4], Re[5], Re[6], Re[7], Re[8]);
  const t = new THREE.Vector3(tvec[0], tvec[1], tvec[2]);
  const camPos = t.clone().applyMatrix3(Rt).negate();

  // Build view matrix (world-to-camera)
  const viewMat = new THREE.Matrix4();
  viewMat.set(
    Re[0],
    Re[3],
    Re[6],
    tvec[0],
    Re[1],
    Re[4],
    Re[7],
    tvec[1],
    Re[2],
    Re[5],
    Re[8],
    tvec[2],
    0,
    0,
    0,
    1,
  );

  // OpenCV camera: X-right, Y-down, Z-forward
  // Three.js camera: X-right, Y-up, Z-backward
  // Flip Y and Z
  const flipYZ = new THREE.Matrix4().set(
    1,
    0,
    0,
    0,
    0,
    -1,
    0,
    0,
    0,
    0,
    -1,
    0,
    0,
    0,
    0,
    1,
  );
  const threeView = flipYZ.clone().multiply(viewMat);

  // Build projection matrix matching OpenCV intrinsics
  const near = 0.05,
    far = 50;
  const w = camWidth,
    h = camHeight;
  const projMat = new THREE.Matrix4();
  projMat.set(
    (2 * fx) / w,
    0,
    -((2 * cx) / w - 1),
    0,
    0,
    (2 * fy) / h,
    -((2 * cy) / h - 1),
    0,
    0,
    0,
    -(far + near) / (far - near),
    (-2 * far * near) / (far - near),
    0,
    0,
    -1,
    0,
  );

  camera.projectionMatrix.copy(projMat);
  camera.projectionMatrixInverse.copy(projMat).invert();
  camera.matrixWorldInverse.copy(threeView);
  camera.matrixWorld.copy(threeView).invert();
  camera.position.setFromMatrixPosition(camera.matrixWorld);
  camera.quaternion.setFromRotationMatrix(camera.matrixWorld);
  camera.matrixAutoUpdate = false;
  camera.matrixWorldAutoUpdate = false;
}

// ---- Init ----
export function init() {
  const canvas = document.getElementById("ar-canvas");
  if (!canvas) return;

  scene = new THREE.Scene();
  clock = new THREE.Clock();
  camera = new THREE.PerspectiveCamera(60, 640 / 480, 0.05, 50);

  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
  } catch (e) {
    console.error("AR overlay: WebGL failed", e);
    canvas.style.display = "none";
    return;
  }

  renderer.setClearColor(0x000000, 0);
  renderer.setSize(640, 480);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  // Lights
  const ambient = new THREE.AmbientLight(0x8899bb, 0.8);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffeedd, 2.0);
  sun.position.set(2, -1, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -3;
  sun.shadow.camera.right = 3;
  sun.shadow.camera.top = 3;
  sun.shadow.camera.bottom = -3;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 10;
  scene.add(sun);

  // Invisible ground plane to receive shadows
  const groundGeo = new THREE.PlaneGeometry(10, 10);
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.4 });
  groundPlane = new THREE.Mesh(groundGeo, groundMat);
  groundPlane.receiveShadow = true;
  // Ground is at z=0 in world coords (XY plane)
  groundPlane.position.set(0.5, 0.5, 0);
  scene.add(groundPlane);

  // Load character
  loadCharacter();
  // Load tree template
  loadTreeTemplate();
  // Create sphere
  createSphere();

  animate();
  console.log("AR overlay initialized");
}

// ---- Load character with walk animation ----
function loadCharacter() {
  characterGroup = new THREE.Group();
  scene.add(characterGroup);

  loader.load("/assets/models/human/human_rigged.glb", (gltf) => {
    const model = gltf.scene;
    model.scale.set(0.15, 0.15, 0.15); // Scale to ~20cm tall for the robot
    model.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });
    characterGroup.add(model);
    characterLoaded = true;

    // Set up animation mixer
    mixer = new THREE.AnimationMixer(model);

    // Load idle animation
    loader.load("/assets/emotes/emote-idle.glb", (idleGltf) => {
      if (idleGltf.animations.length > 0) {
        idleAction = mixer.clipAction(idleGltf.animations[0]);
        idleAction.play();
      }
    });

    // Load walk animation
    loader.load("/assets/emotes/emote-walk.glb", (walkGltf) => {
      if (walkGltf.animations.length > 0) {
        walkAction = mixer.clipAction(walkGltf.animations[0]);
        walkAction.timeScale = 1.3;
      }
    });

    console.log("Character loaded");
  });
}

// ---- Load tree template ----
function loadTreeTemplate() {
  loader.load("/assets/models/tree/tree.glb", (gltf) => {
    treeMeshTemplate = gltf.scene;
    treeMeshTemplate.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });
    console.log("Tree template loaded");
  });
}

// ---- Place trees around perimeter ----
function placeTrees(floorMarkers) {
  if (!treeMeshTemplate || treesPlaced) return;

  const corners = Object.values(floorMarkers).map((p) => [p[0], p[1]]);
  if (corners.length < 3) return;

  // Place trees along edges and slightly outside the perimeter
  const treePositions = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    // Midpoint of each edge, offset outward
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    // Normal pointing outward
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx = (-dy / len) * 0.15,
      ny = (dx / len) * 0.15;
    treePositions.push([mx + nx, my + ny]);
    // Also at each corner, offset outward
    const cx = a[0],
      cy = a[1];
    // Average of adjacent edge normals for corner offset
    const prev = corners[(i - 1 + corners.length) % corners.length];
    const dx2 = a[0] - prev[0],
      dy2 = a[1] - prev[1];
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
    const cnx = (-dy / len - dy2 / len2) * 0.12;
    const cny = (dx / len + dx2 / len2) * 0.12;
    treePositions.push([cx + cnx, cy + cny]);
  }

  treePositions.forEach((pos, i) => {
    const tree = treeMeshTemplate.clone();
    const scale = 0.08 + Math.random() * 0.04; // Vary size
    tree.scale.set(scale, scale, scale);
    tree.position.set(pos[0], pos[1], 0);
    tree.rotation.z = Math.random() * Math.PI * 2; // Random rotation
    scene.add(tree);
  });

  treesPlaced = true;
  console.log(`Placed ${treePositions.length} trees around perimeter`);
}

// ---- Create lit sphere for red ball ----
function createSphere() {
  const geo = new THREE.SphereGeometry(0.04, 32, 32);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xff2222,
    metalness: 0.3,
    roughness: 0.4,
    emissive: 0x440000,
  });
  sphereMesh = new THREE.Mesh(geo, mat);
  sphereMesh.castShadow = true;
  sphereMesh.position.set(0, 0, 0.04); // Slightly above ground
  sphereMesh.visible = false;
  scene.add(sphereMesh);

  // Add a point light inside the sphere for glow effect
  const glow = new THREE.PointLight(0xff4444, 0.5, 0.5);
  sphereMesh.add(glow);
}

// ---- Update from world state ----
export function update(ws) {
  if (!scene || !arEnabled) return;

  const dt = clock.getDelta();

  // Update camera pose
  if (ws.camera_pose) {
    setCameraFromPose(
      ws.camera_pose,
      ws.cam_width || 640,
      ws.cam_height || 480,
    );
  }

  // Place trees once floor markers are known
  if (ws.floor_markers && !treesPlaced) {
    placeTrees(ws.floor_markers);
  }

  // Update character position/animation
  if (ws.robot_position && characterGroup) {
    const rp = ws.robot_position;
    const rh = ws.robot_heading || 0;
    characterGroup.position.set(rp[0], rp[1], 0);
    characterGroup.rotation.set(0, 0, rh - Math.PI / 2); // Face heading direction

    // Detect if robot is moving
    let moving = false;
    if (lastRobotPos) {
      const dx = rp[0] - lastRobotPos[0];
      const dy = rp[1] - lastRobotPos[1];
      moving = Math.sqrt(dx * dx + dy * dy) > 0.005;
    }
    lastRobotPos = [rp[0], rp[1]];

    // Switch animations
    if (moving && !isWalking && walkAction) {
      walkAction.reset().play();
      walkAction.crossFadeFrom(idleAction, 0.3);
      isWalking = true;
    } else if (!moving && isWalking && idleAction) {
      idleAction.reset().play();
      idleAction.crossFadeFrom(walkAction, 0.3);
      isWalking = false;
    }

    characterGroup.visible = true;
  } else if (characterGroup) {
    characterGroup.visible = false;
  }

  // Update sphere position (red ball)
  const redBall = (ws.objects || []).find((o) => o.label === "red_ball");
  if (redBall && sphereMesh) {
    sphereMesh.position.set(redBall.position[0], redBall.position[1], 0.04);
    sphereMesh.visible = true;
    // Gentle bobbing
    sphereMesh.position.z = 0.04 + Math.sin(Date.now() * 0.003) * 0.01;
  } else if (sphereMesh) {
    sphereMesh.visible = false;
  }

  // Update animation
  if (mixer) mixer.update(dt);

  // Render
  renderer.render(scene, camera);
}

export function toggle(enabled) {
  arEnabled = enabled;
  const c = document.getElementById("ar-canvas");
  if (c) c.style.display = enabled ? "block" : "none";
}
