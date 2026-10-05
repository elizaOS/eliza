import path from "node:path";
import { getBrandConfig } from "./brand-config";

export const BACKGROUND_NOTICE_MARKER_FILE = "background-notice-seen.json";

function getBackgroundNoticeTitle(): string {
	return `${getBrandConfig().appName} Is Still Running`;
}

function getBackgroundNoticeBody(): string {
	return `${getBrandConfig().appName} can send notifications and will keep running in the background after you close the window.`;
}

interface BackgroundNoticeFileSystem {
	existsSync: (filePath: string) => boolean;
	mkdirSync: (
		dirPath: string,
		options?: {
			recursive?: boolean;
		},
	) => void;
	writeFileSync: (
		filePath: string,
		data: string,
		encoding: BufferEncoding,
	) => void;
}

export function resolveBackgroundNoticeMarkerPath(userDataDir: string): string {
	return path.join(userDataDir, BACKGROUND_NOTICE_MARKER_FILE);
}

export function hasSeenBackgroundNotice(
	fileSystem: BackgroundNoticeFileSystem,
	userDataDir: string,
): boolean {
	return fileSystem.existsSync(resolveBackgroundNoticeMarkerPath(userDataDir));
}

export function markBackgroundNoticeSeen(
	fileSystem: BackgroundNoticeFileSystem,
	userDataDir: string,
): string {
	const markerPath = resolveBackgroundNoticeMarkerPath(userDataDir);
	fileSystem.mkdirSync(userDataDir, { recursive: true });
	fileSystem.writeFileSync(markerPath, '{"seen":true}\n', "utf8");
	return markerPath;
}

export function showBackgroundNoticeOnce(args: {
	fileSystem: BackgroundNoticeFileSystem;
	userDataDir: string;
	showNotification: (options: { title: string; body: string }) => void;
}): boolean {
	if (hasSeenBackgroundNotice(args.fileSystem, args.userDataDir)) {
		return false;
	}

	args.showNotification({
		title: getBackgroundNoticeTitle(),
		body: getBackgroundNoticeBody(),
	});
	markBackgroundNoticeSeen(args.fileSystem, args.userDataDir);
	return true;
}
