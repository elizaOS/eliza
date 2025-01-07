import { fileURLToPath } from "url";
import { dirname } from "path";
import { ThreeJsRenderer } from "./threeJs.js";
import * as fs from "fs";
import * as path from "path";
import { AudioContext } from "web-audio-api";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
    // Initialize renderer
    const renderer = new ThreeJsRenderer();
    await renderer.initialize();

    // Load VRM model
    await renderer.loadVRM(path.join(__dirname, "../assets/models/model.vrm"));

    // Load audio file
    const audioPath = path.join(__dirname, "../assets/audio/test.mp3");
    const audioContext = new AudioContext();
    const audioBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
        fs.readFile(audioPath, (err, data) => {
            if (err) reject(err);
            audioContext.decodeAudioData(data.buffer, resolve, reject);
        });
    });

    // Process frames
    const samplesPerFrame = Math.floor(audioBuffer.sampleRate / 30); // 30fps
    for (let i = 0; i < audioBuffer.length; i += samplesPerFrame) {
        const audioData = audioBuffer
            .getChannelData(0)
            .slice(i, i + samplesPerFrame);
        await renderer.renderFrame(audioData);
    }

    // Combine frames with audio
    const outputPath = path.join(__dirname, "../output/final_video.mp4");
    await renderer.combineFramesAndAudio(audioPath, outputPath);

    // Cleanup
    renderer.cleanup();
}

main().catch(console.error);
