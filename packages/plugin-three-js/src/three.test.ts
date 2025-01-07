import { ThreeJsRenderer } from "./threeJs.js";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function test() {
    const renderer = new ThreeJsRenderer();
    await renderer.initialize();

    const modelPath = path.join(__dirname, "../assets/models/model.vrm");
    const outputPath = path.join(__dirname, "../output/test_frame.png");

    try {
        console.log("Loading VRM model...");
        await renderer.loadVRM(modelPath);

        console.log("Starting test render...");
        await renderer.renderTestFrame(outputPath);
        console.log("Test render completed successfully!");
    } catch (error) {
        console.error("Error during test render:", error);
    }
}

test().catch(console.error);
