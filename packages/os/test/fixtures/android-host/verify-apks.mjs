import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const directory = path.resolve(process.argv[2] ?? ".");
const tools = path.join(process.env.ANDROID_HOME ?? "", "build-tools", "36.0.0");
const flavors = ["store", "sideload"];
const forbidden = /(\.gguf|\.onnx|\.tflite|\.safetensors)$|libllama|libggml|llama-server|^assets\/models\//;
const rows = flavors.map((flavor) => {
  const name = [`${flavor}-release.apk`, `${flavor}-release-unsigned.apk`, `${flavor}-debug.apk`].find((candidate) => existsSync(path.join(directory, candidate)));
  if (name === undefined) throw new Error(`${flavor} has no APK in ${directory}`);
  const file = path.join(directory, name);
  const entries = execFileSync(path.join(tools, "aapt"), ["list", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n");
  const carried = entries.filter((entry) => forbidden.test(entry));
  if (carried.length) throw new Error(`${name} carries local inference: ${carried.join(", ")}`);
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (name.endsWith("-unsigned.apk")) return { flavor, name, sha256, signer: null };
  const report = execFileSync(path.join(tools, "apksigner"), ["verify", "--print-certs", file], { encoding: "utf8" });
  const signers = [...new Set([...report.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/g)].map((match) => match[1]))];
  if (signers.length !== 1) throw new Error(`${name} has ${signers.length} signers`);
  return { flavor, name, sha256, signer: signers[0] };
});
writeFileSync(path.join(directory, "apk-manifest.json"), `${JSON.stringify(rows, null, 2)}\n`);
