import * as THREE from "three";
import puppeteer from "puppeteer";
import * as path from "path";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

declare global {
    interface Window {
        THREE: typeof THREE & {
            GLTFLoader: any;
            VRM: any;
        };
        GLTFLoader: any;
        FBXLoader: any;
        VRM: any;
        scene: THREE.Scene;
        camera: THREE.PerspectiveCamera;
        renderer: THREE.WebGLRenderer;
        sceneReady: boolean;
        vrm: any;
        animationMixer: THREE.AnimationMixer;
    }
}

export class ThreeJsRenderer {
    private vrm: any; // VRM type
    private frameCount: number = 0;
    private readonly outputDir = path.join(__dirname, "../output");
    private readonly fps = 30;
    private mixer: THREE.AnimationMixer;
    private lastTime: number = 0;
    private browser: puppeteer.Browser | null = null;
    private page: puppeteer.Page | null = null;

    constructor() {
        // Create output directory if it doesn't exist
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    public async initialize() {
        await this.initBrowser();
        await this.setupScene();
    }

    private async initBrowser() {
        this.browser = await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
            defaultViewport: {
                width: 1920,
                height: 1080,
            },
        });

        this.page = await this.browser.newPage();

        // Add console logging
        this.page.on("console", (msg) => console.log("Browser:", msg.text()));

        // Add error handling
        this.page.on("error", (err) => console.error("Browser error:", err));
        this.page.on("pageerror", (err) => console.error("Page error:", err));

        await this.page.setRequestInterception(true);
        this.page.on("request", (request) => {
            if (request.url().startsWith("file://")) {
                const filePath = request.url().replace("file://", "");
                try {
                    const content = fs.readFileSync(filePath);
                    request.respond({
                        status: 200,
                        body: content,
                        headers: {
                            "Access-Control-Allow-Origin": "*",
                            "Content-Type": "application/octet-stream",
                        },
                    });
                } catch (error) {
                    console.error("Error loading file:", error);
                    request.abort();
                }
            } else {
                request.continue();
            }
        });

        await this.page.setContent(`
            <!DOCTYPE html>
            <html>
                <head>
                    <style>
                        body { margin: 0; overflow: hidden; }
                        canvas {
                            display: block;
                            width: 100vw !important;
                            height: 100vh !important;
                        }
                    </style>
                </head>
                <body>
                    <canvas id="three-canvas"></canvas>
                    <script type="importmap">
                    {
                        "imports": {
                            "three": "https://unpkg.com/three@0.152.2/build/three.module.js",
                            "three/addons/": "https://unpkg.com/three@0.152.2/examples/jsm/",
                            "@pixiv/three-vrm": "https://unpkg.com/@pixiv/three-vrm@0.6.7/lib/three-vrm.module.js"
                        }
                    }
                    </script>
                    <script type="module">
                        import * as THREE from 'three';
                        import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
                        import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
                        import { VRM } from '@pixiv/three-vrm';

                        window.THREE = THREE;
                        window.GLTFLoader = GLTFLoader;
                        window.FBXLoader = FBXLoader;
                        window.VRM = VRM;
                        window.sceneReady = false;

                        console.log('Loaders initialized:', {
                            GLTFLoader: !!window.GLTFLoader,
                            VRM: !!window.VRM
                        });

                        async function initScene() {
                            console.log('Initializing scene...');
                            const canvas = document.getElementById('three-canvas');

                            window.scene = new THREE.Scene();
                            window.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
                            window.camera.position.set(0, 1.4, 1.2);
                            window.camera.lookAt(0, 1.28, 0);

                            window.renderer = new THREE.WebGLRenderer({
                                canvas,
                                alpha: true,
                                antialias: true
                            });
                            window.renderer.setSize(window.innerWidth, window.innerHeight);
                            window.renderer.setClearColor(0x808080);

                            const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
                            const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
                            directionalLight.position.set(0, 1, 2);
                            window.scene.add(ambientLight, directionalLight);

                            window.renderer.render(window.scene, window.camera);
                            window.sceneReady = true;
                            console.log('Scene initialized');
                        }

                        initScene();
                    </script>
                </body>
            </html>
        `);

        // Wait for scene to be fully initialized
        await this.page.waitForFunction(() => window.sceneReady === true);
    }

    public async setupScene() {
        // Additional scene setup can go here
        await this.page.evaluate(() => {
            window.renderer.render(window.scene, window.camera);
        });
    }

    private async loadAnimation() {
        const animationPath = path.join(
            __dirname,
            "../assets/animations/offensive_idle.fbx"
        );
        const fileContent = fs.readFileSync(animationPath);
        const base64Content = fileContent.toString("base64");
        const dataUrl = `data:application/octet-stream;base64,${base64Content}`;

        await this.page.evaluate(async (animUrl) => {
            try {
                const boneMap = {
                    // Core body
                    mixamorigHips: "hips",
                    mixamorigSpine: "spine",
                    mixamorigSpine1: "chest",
                    mixamorigSpine2: "chest", // Map Spine2 to chest as well
                    mixamorigNeck: "neck",
                    mixamorigHead: "head",

                    // Left arm and fingers
                    mixamorigLeftShoulder: "shoulderL",
                    mixamorigLeftArm: "upper_armL",
                    mixamorigLeftForeArm: "lower_armL",
                    mixamorigLeftHand: "handL",
                    mixamorigLeftHandThumb1: "thumb_proximalL",
                    mixamorigLeftHandThumb2: "thumb_intermediateL",
                    mixamorigLeftHandThumb3: "thumb_distalL",
                    mixamorigLeftHandIndex1: "index_proximalL",
                    mixamorigLeftHandIndex2: "index_intermediateL",
                    mixamorigLeftHandIndex3: "index_distalL",
                    mixamorigLeftHandMiddle1: "middle_proximalL",
                    mixamorigLeftHandMiddle2: "middle_intermediateL",
                    mixamorigLeftHandMiddle3: "middle_distalL",
                    mixamorigLeftHandRing1: "ring_proximalL",
                    mixamorigLeftHandRing2: "ring_intermediateL",
                    mixamorigLeftHandRing3: "ring_distalL",
                    mixamorigLeftHandPinky1: "little_proximalL",
                    mixamorigLeftHandPinky2: "little_intermediateL",
                    mixamorigLeftHandPinky3: "little_distalL",

                    // Right arm and fingers
                    mixamorigRightShoulder: "shoulderR",
                    mixamorigRightArm: "upper_armR",
                    mixamorigRightForeArm: "lower_armR",
                    mixamorigRightHand: "handR",
                    mixamorigRightHandThumb1: "thumb_proximalR",
                    mixamorigRightHandThumb2: "thumb_intermediateR",
                    mixamorigRightHandThumb3: "thumb_distalR",
                    mixamorigRightHandIndex1: "index_proximalR",
                    mixamorigRightHandIndex2: "index_intermediateR",
                    mixamorigRightHandIndex3: "index_distalR",
                    mixamorigRightHandMiddle1: "middle_proximalR",
                    mixamorigRightHandMiddle2: "middle_intermediateR",
                    mixamorigRightHandMiddle3: "middle_distalR",
                    mixamorigRightHandRing1: "ring_proximalR",
                    mixamorigRightHandRing2: "ring_intermediateR",
                    mixamorigRightHandRing3: "ring_distalR",
                    mixamorigRightHandPinky1: "little_proximalR",
                    mixamorigRightHandPinky2: "little_intermediateR",
                    mixamorigRightHandPinky3: "little_distalR",

                    // Legs
                    mixamorigLeftUpLeg: "upper_legL",
                    mixamorigLeftLeg: "lower_legL",
                    mixamorigLeftFoot: "footL",
                    mixamorigLeftToeBase: "toesL",
                    mixamorigRightUpLeg: "upper_legR",
                    mixamorigRightLeg: "lower_legR",
                    mixamorigRightFoot: "footR",
                    mixamorigRightToeBase: "toesR",
                };

                const loader = new window.FBXLoader();
                const fbx = await new Promise((resolve, reject) => {
                    loader.load(
                        animUrl,
                        (result) => resolve(result),
                        undefined,
                        reject
                    );
                });

                const clip = THREE.AnimationClip.findByName(
                    (fbx as any).animations,
                    "mixamo.com"
                );
                if (!clip) throw new Error("Animation clip not found");

                const tracks = clip.tracks
                    .map((track) => {
                        const [boneName, propertyName] = track.name.split(".");
                        const vrmBoneName = boneMap[boneName];

                        if (vrmBoneName) {
                            if (
                                track instanceof THREE.QuaternionKeyframeTrack
                            ) {
                                return new THREE.QuaternionKeyframeTrack(
                                    `${vrmBoneName}.${propertyName}`,
                                    track.times,
                                    track.values
                                );
                            } else if (
                                track instanceof THREE.VectorKeyframeTrack
                            ) {
                                return new THREE.VectorKeyframeTrack(
                                    `${vrmBoneName}.${propertyName}`,
                                    track.times,
                                    track.values
                                );
                            }
                        }
                        return null;
                    })
                    .filter((track) => track !== null);

                const retargetedClip = new THREE.AnimationClip(
                    "vrmAnimation",
                    clip.duration,
                    tracks
                );
                const mixer = new THREE.AnimationMixer(window.vrm.scene);
                const action = mixer.clipAction(retargetedClip);
                action.play();

                window.animationMixer = mixer;
            } catch (error) {
                console.error("Error loading animation:", error);
                throw error;
            }
        }, dataUrl);

        this.mixer = await this.page.evaluate(() => window.animationMixer);
    }

    private setupBlinking() {
        const blinkAction = () => {
            if (this.vrm?.expressionManager) {
                const blinkIndex =
                    this.vrm.expressionManager.getExpressionTrackName("blink");
                if (blinkIndex !== null) {
                    // Gradually close eyes over 60ms
                    let closeProgress = 0;
                    const closeInterval = setInterval(() => {
                        closeProgress += 0.1;
                        this.vrm.expressionManager.setValue(
                            "blink",
                            closeProgress
                        );
                        if (closeProgress >= 1.0) {
                            clearInterval(closeInterval);
                        }
                    }, 6);
                }
            }
        };

        setInterval(blinkAction, Math.random() * 4000 + 4000);
    }

    public async renderFrame(audioData: Float32Array) {
        const currentTime = Date.now();
        const deltaTime = (currentTime - this.lastTime) / 1000;
        this.lastTime = currentTime;

        // Update animation
        this.mixer?.update(deltaTime);

        // Update mouth shape based on audio amplitude
        const amplitude = this.calculateAudioAmplitude(audioData);
        await this.page.evaluate((amplitude) => {
            if (!window.vrm?.expressionManager) return;

            // Try all possible expression names
            const expressions = [
                "aa",
                "ee",
                "ih",
                "oh",
                "ou", // Common mouth shapes
                "happy",
                "angry",
                "sad", // Emotions
                "a",
                "e",
                "i",
                "o",
                "u", // Alternative names
                "blendShape.a", // VRM 0.x style
                "Fcl_MTH_A", // VRM 1.0 style
                "MTH_A", // Another common prefix
            ];

            expressions.forEach((exp) => {
                try {
                    window.vrm.expressionManager.setValue(exp, amplitude);
                } catch (e) {
                    // Ignore errors for missing expressions
                }
            });

            window.vrm.update();
        }, amplitude);

        // Render frame
        await this.page.evaluate(() => {
            window.renderer.render(window.scene, window.camera);
        });

        // Save frame as image
        const frameNumber = this.frameCount.toString().padStart(6, "0");
        const framePath = path.join(this.outputDir, `frame_${frameNumber}.png`);

        const buffer = await this.page.screenshot({
            type: "png",
            clip: { x: 0, y: 0, width: 1920, height: 1080 },
        });
        fs.writeFileSync(framePath, buffer);

        this.frameCount++;
    }

    private calculateAudioAmplitude(audioData: Float32Array): number {
        const sum = audioData.reduce((acc, val) => acc + Math.abs(val), 0);
        return Math.min((sum / audioData.length) * 3, 1); // Normalize and scale
    }

    public async combineFramesAndAudio(audioPath: string, outputPath: string) {
        return new Promise((resolve, reject) => {
            ffmpeg()
                .input(`${this.outputDir}/frame_%06d.png`)
                .inputFPS(this.fps)
                .input(audioPath)
                .videoCodec("libx264")
                .outputOptions("-pix_fmt yuv420p")
                .output(outputPath)
                .on("end", resolve)
                .on("error", reject)
                .run();
        });
    }

    public cleanup() {
        // Clean up temporary frame files
        fs.readdirSync(this.outputDir)
            .filter((file) => file.startsWith("frame_"))
            .forEach((file) => fs.unlinkSync(path.join(this.outputDir, file)));
    }

    public async renderTestFrame(outputPath: string) {
        // Ensure VRM is loaded
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Position test - make the model do a specific pose
        await this.page.evaluate(() => {
            if (window.vrm?.expressionManager) {
                window.vrm.expressionManager.setValue("aa", 1); // Open mouth fully
                window.vrm.expressionManager.setValue("blink", 0.5); // Half blink
            }

            // Render frame
            window.renderer.render(window.scene, window.camera);
        });

        // Save single frame
        const buffer = await this.page.screenshot({
            type: "png",
            clip: { x: 0, y: 0, width: 1920, height: 1080 },
        });
        fs.writeFileSync(outputPath, buffer);

        console.log(`Test frame saved to: ${outputPath}`);
    }

    public async loadVRM(modelPath: string) {
        console.log("Starting VRM load:", modelPath);
        const fileContent = fs.readFileSync(modelPath);
        const base64Content = fileContent.toString("base64");
        const dataUrl = `data:application/octet-stream;base64,${base64Content}`;

        // Store VRM instance from browser context
        const vrmData = await this.page.evaluate(async (modelUrl) => {
            try {
                const loader = new window.GLTFLoader();

                console.log("Loading VRM file...");
                const gltf = await new Promise((resolve, reject) => {
                    loader.load(
                        modelUrl,
                        async (gltf) => {
                            try {
                                const vrm = await window.VRM.from(gltf);
                                gltf.userData.vrm = vrm;
                                resolve(gltf);
                            } catch (e) {
                                reject(e);
                            }
                        },
                        (progress) => console.log("Load progress:", progress),
                        reject
                    );
                });

                window.vrm = (gltf as any).userData.vrm;
                if (!window.vrm) {
                    throw new Error("VRM not found in loaded model");
                }

                window.vrm.scene.rotation.y = Math.PI;
                window.scene.add((gltf as any).scene);
                console.log("VRM model loaded successfully");
                window.renderer.render(window.scene, window.camera);

                console.log("VRM Expression System:", {
                    manager: window.vrm.expressionManager,
                    expressions: window.vrm.expressionManager?.expressions,
                    presets: window.vrm.expressionManager?.presetExpressions,
                    custom: window.vrm.expressionManager?.customExpressions,
                });

                // Debug VRM structure
                if (window.vrm.scene.children[0]) {
                    console.log("First child morphs:", {
                        dictionary:
                            window.vrm.scene.children[0].morphTargetDictionary,
                        influences:
                            window.vrm.scene.children[0].morphTargetInfluences,
                    });
                }

                // Try to find any mesh with morph targets
                window.vrm.scene.traverse((node) => {
                    if (node.morphTargetDictionary) {
                        console.log("Found morph targets on node:", {
                            name: node.name,
                            morphs: node.morphTargetDictionary,
                        });
                    }
                });

                // Return the VRM data we need
                return {
                    scene: window.vrm.scene.toJSON(),
                    expressions: Object.keys(
                        window.vrm.expressionManager?.expressions || {}
                    ),
                };
            } catch (error) {
                console.error("Error loading VRM:", error);
                throw error;
            }
        }, dataUrl);

        // Store the actual VRM instance
        this.vrm = await this.page.evaluate(() => window.vrm);

        // Log available expressions
        console.log(
            "Available VRM expressions:",
            await this.page.evaluate(() =>
                Object.keys(window.vrm?.expressionManager?.expressions || {})
            )
        );

        // Initialize animation mixer
        await this.loadAnimation();
        this.setupBlinking();
    }
}
