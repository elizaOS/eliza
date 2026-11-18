import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const directory = path.resolve(process.argv[2] ?? "artifacts");
const tools = path.join(process.env.ANDROID_HOME ?? "", "build-tools", "36.0.0");
const flavors = ["store", "sideload"];
const forbidden = /(\.gguf|\.onnx|\.tflite|\.safetensors)$|libllama|libggml|llama-server|^assets\/models\//;
const rows = readdirSync(directory)
  .filter((name) => name.endsWith(".apk") && flavors.some((flavor) => name.startsWith(`${flavor}-release`)))
  .sort()
  .map((name) => {
    const file = path.join(directory, name);
    const entries = execFileSync(path.join(tools, "aapt"), ["list", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n");
    const carried = entries.filter((entry) => forbidden.test(entry));
    if (carried.length) throw new Error(`${name} carries local inference: ${carried.join(", ")}`);
    const signed = !name.endsWith("-unsigned.apk");
    const report = signed ? execFileSync(path.join(tools, "apksigner"), ["verify", "--print-certs", file], { encoding: "utf8" }) : "";
    const signers = [...new Set([...report.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/g)].map((match) => match[1]))];
    if (signed && signers.length !== 1) throw new Error(`${name} has ${signers.length} signers`);
    return {
      flavor: flavors.find((flavor) => name.startsWith(`${flavor}-`)),
      name,
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
      signer: signed ? signers[0] : null,
    };
  });
writeFileSync(path.join(directory, "apk-manifest.json"), `${JSON.stringify(rows, null, 2)}\n`);
