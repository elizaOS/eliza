// Ambient module declarations for untyped dependencies used by this plugin.
//
// Lives as a `.ts` file (not `.d.ts`) because `plugins/plugin-discord/**/*.d.ts`
// is gitignored as stray declaration emit; these are hand-authored, committable
// type declarations and must be tracked.

// `fluent-ffmpeg` ships no type declarations and `@types/fluent-ffmpeg` is not
// installed. Declare the real subset of its API surface used by attachments.ts.
declare module "fluent-ffmpeg" {
	interface FfprobeStream {
		codec_type?: string;
		[key: string]: unknown;
	}

	interface FfprobeData {
		streams: FfprobeStream[];
		[key: string]: unknown;
	}

	interface FfmpegCommand {
		noVideo(): FfmpegCommand;
		audioCodec(codec: string): FfmpegCommand;
		toFormat(format: string): FfmpegCommand;
		output(target: string): FfmpegCommand;
		run(): void;
		on(event: "end", listener: () => void): FfmpegCommand;
		on(event: "error", listener: (err: Error) => void): FfmpegCommand;
		on(event: string, listener: (...args: unknown[]) => void): FfmpegCommand;
	}

	interface FfmpegFactory {
		(input?: string): FfmpegCommand;
		ffprobe(
			file: string,
			callback: (err: Error | null, data: FfprobeData) => void,
		): void;
	}

	const ffmpeg: FfmpegFactory;
	export default ffmpeg;
}

// `jsdom` ships no type declarations. The transitively-imported
// `@elizaos/plugin-browser` workspace sources reference it; plugin-browser
// supplies its own ambient declaration via its `include` glob, but that file is
// not in scope when those sources are pulled into this package's compilation.
// Mirror the same real surface here. Keep in sync with
// plugins/plugin-browser/src/ambient-jsdom.d.ts.
declare module "jsdom" {
	export class JSDOM {
		constructor(
			html?: string,
			options?: {
				url?: string;
				pretendToBeVisual?: boolean;
				[key: string]: unknown;
			},
		);
		window: Window & typeof globalThis;
		serialize(): string;
	}
}
