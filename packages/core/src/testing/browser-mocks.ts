/**
 * Shared browser API helpers for test setup files.
 *
 * Used by both test/setup.ts and apps/app/test/setup.ts to avoid duplicating
 * Storage, Canvas2D, and console error suppression logic.
 */

const CANVAS_PATCH_MARK = Symbol.for("elizaos.test.canvasMocksInstalled");
const CONSOLE_PATCH_MARK = Symbol.for("elizaos.test.consoleErrorPatched");
const CONSOLE_WARN_PATCH_MARK = Symbol.for("elizaos.test.consoleWarnPatched");
const CONSOLE_LOG_PATCH_MARK = Symbol.for("elizaos.test.consoleLogPatched");
const MEDIA_PATCH_MARK = Symbol.for("elizaos.test.mediaMocksInstalled");
const AUDIO_PATCH_MARK = Symbol.for("elizaos.test.audioMocksInstalled");

/**
 * Create an in-memory Storage implementation backed by a Map.
 */
export function createMemoryStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem(key: string) {
			return store.get(key) ?? null;
		},
		setItem(key: string, value: string) {
			store.set(key, value);
		},
		removeItem(key: string) {
			store.delete(key);
		},
		clear() {
			store.clear();
		},
		get length() {
			return store.size;
		},
		key(index: number) {
			return [...store.keys()][index] ?? null;
		},
	} as Storage;
}

/** Type guard: does the value implement the Storage interface? */
export function hasStorageApi(value: unknown): value is Storage {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof (value as Storage).getItem === "function" &&
			typeof (value as Storage).setItem === "function" &&
			typeof (value as Storage).removeItem === "function" &&
			typeof (value as Storage).clear === "function",
	);
}

/**
 * Create a Canvas 2D rendering context shim for the common operations used in tests.
 */
export function createCanvas2DContext(): CanvasRenderingContext2D {
	const context: Partial<CanvasRenderingContext2D> &
		Pick<
			CanvasRenderingContext2D,
			| "canvas"
			| "lineWidth"
			| "globalAlpha"
			| "fillStyle"
			| "strokeStyle"
			| "fillRect"
			| "clearRect"
			| "getImageData"
			| "putImageData"
			| "drawImage"
			| "beginPath"
			| "closePath"
			| "moveTo"
			| "lineTo"
			| "stroke"
			| "fill"
			| "arc"
			| "rect"
			| "save"
			| "restore"
			| "translate"
			| "rotate"
			| "scale"
			| "transform"
			| "setTransform"
			| "resetTransform"
			| "fillText"
			| "strokeText"
			| "measureText"
			| "createLinearGradient"
			| "createRadialGradient"
			| "createPattern"
		> = {
		fillRect() {},
		clearRect() {},
		getImageData() {
			return {
				data: new Uint8ClampedArray(0),
				width: 0,
				height: 0,
				colorSpace: "srgb",
			} as ImageData;
		},
		putImageData() {},
		drawImage() {},
		beginPath() {},
		closePath() {},
		moveTo() {},
		lineTo() {},
		stroke() {},
		fill() {},
		arc() {},
		rect() {},
		save() {},
		restore() {},
		translate() {},
		rotate() {},
		scale() {},
		transform() {},
		setTransform() {},
		resetTransform() {},
		fillText() {},
		strokeText() {},
		measureText() {
			return { width: 0 } as TextMetrics;
		},
		createLinearGradient() {
			return { addColorStop() {} };
		},
		createRadialGradient() {
			return { addColorStop() {} };
		},
		createPattern() {
			return null;
		},
		canvas:
			typeof document !== "undefined"
				? document.createElement("canvas")
				: ({} as HTMLCanvasElement),
		lineWidth: 1,
		globalAlpha: 1,
		fillStyle: "#000",
		strokeStyle: "#000",
	};
	return context as CanvasRenderingContext2D;
}

/**
 * Install canvas shims on HTMLCanvasElement.prototype if available.
 */
export function installCanvasShims(): void {
	if (typeof globalThis.HTMLCanvasElement === "undefined") return;
	const prototype = globalThis.HTMLCanvasElement
		.prototype as HTMLCanvasElement & {
		[CANVAS_PATCH_MARK]?: boolean;
	};
	if (prototype[CANVAS_PATCH_MARK]) return;

	Object.defineProperty(prototype, "getContext", {
		value(contextType: string) {
			return contextType === "2d" ? createCanvas2DContext() : null;
		},
		writable: true,
		configurable: true,
	});

	Object.defineProperty(prototype, "toDataURL", {
		value() {
			return "data:image/png;base64,dGVzdA==";
		},
		writable: true,
		configurable: true,
	});

	prototype[CANVAS_PATCH_MARK] = true;
}

/**
 * Install HTMLMediaElement and Audio shims to avoid jsdom "Not implemented"
 * warnings when tests exercise preview or playback flows.
 */
export function installMediaElementShims(): void {
	if (typeof globalThis.HTMLMediaElement === "undefined") return;

	const prototype = globalThis.HTMLMediaElement
		.prototype as HTMLMediaElement & {
		[MEDIA_PATCH_MARK]?: boolean;
	};
	if (!prototype[MEDIA_PATCH_MARK]) {
		Object.defineProperty(prototype, "load", {
			value() {},
			writable: true,
			configurable: true,
		});
		Object.defineProperty(prototype, "play", {
			value() {
				return Promise.resolve();
			},
			writable: true,
			configurable: true,
		});
		Object.defineProperty(prototype, "pause", {
			value() {},
			writable: true,
			configurable: true,
		});
		prototype[MEDIA_PATCH_MARK] = true;
	}

	const globalObject = globalThis as typeof globalThis & {
		Audio?: typeof Audio & {
			[AUDIO_PATCH_MARK]?: boolean;
		};
	};
	if (typeof document === "undefined") return;
	if (globalObject.Audio?.[AUDIO_PATCH_MARK]) return;

	const AudioShim = function AudioShim(src?: string) {
		const audio = document.createElement("audio");
		if (typeof src === "string") {
			audio.src = src;
		}
		return audio;
	} as unknown as typeof Audio & {
		[AUDIO_PATCH_MARK]?: boolean;
	};
	AudioShim[AUDIO_PATCH_MARK] = true;

	Object.defineProperty(globalObject, "Audio", {
		value: AudioShim,
		writable: true,
		configurable: true,
	});
}

/**
 * Suppress known noisy console.error messages from React test tooling.
 */
export function suppressReactTestConsoleErrors(): void {
	const currentConsoleError = console.error as typeof console.error & {
		[CONSOLE_PATCH_MARK]?: boolean;
	};
	if (currentConsoleError[CONSOLE_PATCH_MARK]) {
		return;
	}
	const originalConsoleError = console.error.bind(console);
	const patchedConsoleError = ((...args: unknown[]) => {
		const first = args[0];
		if (
			typeof first === "string" &&
			(first.includes("react-test-renderer is deprecated") ||
				first.includes(
					"The current testing environment is not configured to support act(...)",
				) ||
				first.includes("was not wrapped in act(...)"))
		) {
			return;
		}
		originalConsoleError(...args);
	}) as typeof console.error & {
		[CONSOLE_PATCH_MARK]?: boolean;
	};
	patchedConsoleError[CONSOLE_PATCH_MARK] = true;
	console.error = patchedConsoleError;

	const currentConsoleWarn = console.warn as typeof console.warn & {
		[CONSOLE_WARN_PATCH_MARK]?: boolean;
	};
	if (!currentConsoleWarn[CONSOLE_WARN_PATCH_MARK]) {
		const originalConsoleWarn = console.warn.bind(console);
		const patchedConsoleWarn = ((...args: unknown[]) => {
			const first = args[0];
			if (
				typeof first === "string" &&
				(first.includes("[openExternalUrl]") ||
					first.includes("[RenderGuard]") ||
					first.includes("[persistence] localStorage operation failed:") ||
					first.includes(
						"[Gateway] mDNS discovery not available - desktop bridge not configured",
					))
			) {
				return;
			}
			originalConsoleWarn(...args);
		}) as typeof console.warn & {
			[CONSOLE_WARN_PATCH_MARK]?: boolean;
		};
		patchedConsoleWarn[CONSOLE_WARN_PATCH_MARK] = true;
		console.warn = patchedConsoleWarn;
	}

	const currentConsoleLog = console.log as typeof console.log & {
		[CONSOLE_LOG_PATCH_MARK]?: boolean;
	};
	if (!currentConsoleLog[CONSOLE_LOG_PATCH_MARK]) {
		const originalConsoleLog = console.log.bind(console);
		const patchedConsoleLog = ((...args: unknown[]) => {
			const first = args[0];
			if (
				typeof first === "string" &&
				first.includes("[shell] switchShellView:")
			) {
				return;
			}
			originalConsoleLog(...args);
		}) as typeof console.log & {
			[CONSOLE_LOG_PATCH_MARK]?: boolean;
		};
		patchedConsoleLog[CONSOLE_LOG_PATCH_MARK] = true;
		console.log = patchedConsoleLog;
	}
}
