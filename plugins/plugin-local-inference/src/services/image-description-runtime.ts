import { readFile } from "node:fs/promises";
import path from "node:path";
import { localInferenceEngine } from "./engine";
import type { LocalInferenceLoadArgs } from "./load-args";

interface BundleManifestFile {
	path: string;
	ctx?: number;
}

interface BundleManifest {
	files?: {
		text?: BundleManifestFile[];
		vision?: BundleManifestFile[];
	};
}

export interface ImageDescriptionRuntimeOptions {
	tier: string;
	modelPath: string;
}

export interface ImageDescriptionRuntime {
	describe(args: {
		imagePath: string;
		prompt: string;
		maxTokens?: number;
	}): Promise<string>;
	cleanup?(): Promise<void>;
}

export async function createImageDescriptionRuntime(
	args: ImageDescriptionRuntimeOptions,
): Promise<ImageDescriptionRuntime> {
	const bundleRoot = path.resolve(args.modelPath);
	const manifest = await readBundleManifest(bundleRoot);
	const textModelPath = resolveTextModelPath(bundleRoot, manifest, args.tier);
	const mmprojPath = resolveVisionModelPath(bundleRoot, manifest, args.tier);
	const loadArgs: LocalInferenceLoadArgs = {
		modelPath: textModelPath,
		mmprojPath,
		contextSize: 4096,
	};

	await localInferenceEngine.load(textModelPath, loadArgs);

	return {
		async describe({ imagePath, prompt, maxTokens }) {
			const bytes = await readImageInput(imagePath);
			const result = await localInferenceEngine.describeImage({
				bytes,
				mimeType: mimeTypeFor(imagePath),
				prompt,
				maxTokens,
				temperature: 0,
			});
			return result.text;
		},
		async cleanup() {
			await localInferenceEngine.unload();
		},
	};
}

async function readBundleManifest(bundleRoot: string): Promise<BundleManifest> {
	const manifestPath = path.join(bundleRoot, "eliza-1.manifest.json");
	const raw = await readFile(manifestPath, "utf8");
	return JSON.parse(raw) as BundleManifest;
}

function resolveTextModelPath(
	bundleRoot: string,
	manifest: BundleManifest,
	tier: string,
): string {
	const textFiles = manifest.files?.text ?? [];
	const selected = [...textFiles].sort(
		(a, b) => (a.ctx ?? 0) - (b.ctx ?? 0),
	)[0];
	if (selected?.path) return path.join(bundleRoot, selected.path);
	const slug = tier.replace(/^eliza-1-/, "");
	return path.join(bundleRoot, "text", `eliza-1-${slug}-64k.gguf`);
}

function resolveVisionModelPath(
	bundleRoot: string,
	manifest: BundleManifest,
	tier: string,
): string {
	const selected = manifest.files?.vision?.[0];
	if (selected?.path) return path.join(bundleRoot, selected.path);
	const slug = tier.replace(/^eliza-1-/, "");
	return path.join(bundleRoot, "vision", `mmproj-${slug}.gguf`);
}

async function readImageInput(imagePath: string): Promise<Uint8Array> {
	if (imagePath.startsWith("data:")) {
		const comma = imagePath.indexOf(",");
		if (comma < 0) throw new Error("invalid data URL image input");
		const encoded = imagePath.slice(comma + 1);
		return Uint8Array.from(Buffer.from(encoded, "base64"));
	}
	return Uint8Array.from(await readFile(imagePath));
}

function mimeTypeFor(imagePath: string): string | undefined {
	if (imagePath.startsWith("data:")) {
		const match = /^data:([^;,]+)/.exec(imagePath);
		return match?.[1];
	}
	const ext = path.extname(imagePath).toLowerCase();
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	return undefined;
}
