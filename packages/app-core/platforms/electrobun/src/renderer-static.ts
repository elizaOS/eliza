import path from "node:path";

type ExistsSyncLike = (filePath: string) => boolean;
type StatSyncLike = (filePath: string) => { isDirectory(): boolean };

export type ResolvedRendererAsset = {
	filePath: string;
	isGzipped: boolean;
	mimeExt: string;
};

type ResolveRendererAssetOptions = {
	rendererDir: string;
	urlPath: string;
	existsSync: ExistsSyncLike;
	statSync: StatSyncLike;
};

function stripGzipSuffix(filePath: string): string {
	return filePath.toLowerCase().endsWith(".gz")
		? filePath.slice(0, -3)
		: filePath;
}

function resolveMimeExtension(filePath: string): string {
	const uncompressedPath = stripGzipSuffix(filePath);
	return (
		path.extname(uncompressedPath).toLowerCase() ||
		path.extname(filePath).toLowerCase()
	);
}

export function resolveRendererAsset({
	rendererDir,
	urlPath,
	existsSync,
	statSync,
}: ResolveRendererAssetOptions): ResolvedRendererAsset {
	const relativePath = urlPath.replace(/^\/+/, "") || "index.html";
	let filePath = path.join(rendererDir, relativePath);
	const bundledIndexPath = path.join(rendererDir, "index.html");

	if (
		!filePath.startsWith(rendererDir + path.sep) &&
		filePath !== rendererDir
	) {
		filePath = bundledIndexPath;
	}

	let isGzipped = false;

	if (!existsSync(filePath) && filePath.toLowerCase().endsWith(".gz")) {
		const plainPath = filePath.slice(0, -3);
		if (existsSync(plainPath)) {
			filePath = plainPath;
		}
	}

	if (!existsSync(filePath) && existsSync(`${filePath}.gz`)) {
		filePath = `${filePath}.gz`;
		isGzipped = true;
	}

	if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
		return {
			filePath: bundledIndexPath,
			isGzipped: false,
			mimeExt: ".html",
		};
	}

	return {
		filePath,
		isGzipped,
		mimeExt: resolveMimeExtension(filePath),
	};
}
