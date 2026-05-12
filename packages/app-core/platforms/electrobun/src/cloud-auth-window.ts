export interface CloudAuthWindowFrame {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CloudAuthWindowLike {
	focus(): void;
	close(): void;
	on(event: "close" | "focus", handler: () => void): void;
	webview: {
		loadURL: (url: string) => void;
		on: (
			event: "dom-ready" | "will-navigate" | "host-message",
			handler: (event?: unknown) => void,
		) => void;
	};
}

export interface CreateCloudAuthWindowOptions {
	title: string;
	url: string;
	preload: string | null;
	frame: CloudAuthWindowFrame;
	titleBarStyle: "default";
	transparent: boolean;
	sandbox: boolean;
}

interface CloudAuthWindowManagerOptions {
	createWindow: (options: CreateCloudAuthWindowOptions) => CloudAuthWindowLike;
	onWindowFocused?: (window: CloudAuthWindowLike) => void;
}

const CLOUD_WINDOW_FRAME: CloudAuthWindowFrame = {
	x: 220,
	y: 140,
	width: 1280,
	height: 900,
};
const TRUSTED_ELIZA_HOST_SUFFIXES = ["elizacloud.ai", "elizaos.ai"] as const;
const TRUSTED_ELIZA_CLOSE_MESSAGE_TYPE = "eliza.trusted-eliza-window.close";
const TRUSTED_ELIZA_WINDOW_PRELOAD = `(() => {
  const emitHostMessage = (message) => {
    setTimeout(() => {
      const bridge =
        window.__electrobunEventBridge || window.__electrobunInternalBridge;
      bridge?.postMessage(
        JSON.stringify({
          id: "webviewEvent",
          type: "message",
          payload: {
            id: window.__electrobunWebviewId,
            eventName: "host-message",
            detail: JSON.stringify(message),
          },
        }),
      );
    });
  };
  const closeSelf = () => {
    emitHostMessage({
      type: ${JSON.stringify(TRUSTED_ELIZA_CLOSE_MESSAGE_TYPE)},
    });
  };
  try {
    Object.defineProperty(window, "close", {
      configurable: false,
      writable: false,
      value: closeSelf,
    });
    Object.defineProperty(globalThis, "close", {
      configurable: false,
      writable: false,
      value: closeSelf,
    });
  } catch {
    try {
      window.close = closeSelf;
      globalThis.close = closeSelf;
    } catch {}
  }
})();`;

export function isTrustedElizaUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return false;
		}

		const hostname = url.hostname.toLowerCase();
		return TRUSTED_ELIZA_HOST_SUFFIXES.some(
			(suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
		);
	} catch {
		return false;
	}
}

type NavigationEventLike =
	| string
	| {
			url?: string;
			data?: { detail?: string };
			preventDefault?: () => void;
	  }
	| null
	| undefined;

export function readNavigationEventUrl(event: NavigationEventLike): string {
	if (typeof event === "string") {
		return event;
	}

	if (typeof event?.url === "string") {
		return event.url;
	}

	if (typeof event?.data?.detail === "string") {
		return event.data.detail;
	}

	return "";
}

type HostMessageEventLike =
	| {
			detail?: unknown;
			data?: { detail?: unknown };
	  }
	| null
	| undefined;

function readHostMessageEventDetail(event: HostMessageEventLike): unknown {
	if (event && "detail" in event && event.detail !== undefined) {
		return event.detail;
	}

	return event?.data?.detail;
}

function isTrustedElizaCloseMessage(event: HostMessageEventLike): boolean {
	const detail = readHostMessageEventDetail(event);
	if (typeof detail === "string") {
		try {
			const parsed = JSON.parse(detail) as { type?: unknown };
			return parsed.type === TRUSTED_ELIZA_CLOSE_MESSAGE_TYPE;
		} catch {
			return false;
		}
	}

	if (!detail || typeof detail !== "object") {
		return false;
	}

	return "type" in detail && detail.type === TRUSTED_ELIZA_CLOSE_MESSAGE_TYPE;
}

export class CloudAuthWindowManager {
	private window: CloudAuthWindowLike | null = null;
	private readonly createWindowFn: CloudAuthWindowManagerOptions["createWindow"];
	private readonly onWindowFocused?: CloudAuthWindowManagerOptions["onWindowFocused"];

	constructor(options: CloudAuthWindowManagerOptions) {
		this.createWindowFn = options.createWindow;
		this.onWindowFocused = options.onWindowFocused;
	}

	open(url: string): boolean {
		if (!isTrustedElizaUrl(url)) {
			console.warn(
				`[CloudAuthWindow] Rejected open(): URL is not a trusted Eliza origin: ${url}`,
			);
			return false;
		}

		if (this.window) {
			this.window.webview.loadURL(url);
			this.window.focus();
			return true;
		}

		const window = this.createWindowFn({
			title: "Eliza Cloud",
			url,
			preload: TRUSTED_ELIZA_WINDOW_PRELOAD,
			frame: CLOUD_WINDOW_FRAME,
			titleBarStyle: "default",
			transparent: false,
			sandbox: true,
		});

		this.window = window;
		this.onWindowFocused?.(window);

		window.webview.on("host-message", (event) => {
			if (!isTrustedElizaCloseMessage(event as HostMessageEventLike)) {
				return;
			}
			window.close();
		});
		window.on("focus", () => {
			this.onWindowFocused?.(window);
		});
		window.on("close", () => {
			if (this.window === window) {
				this.window = null;
			}
		});

		return true;
	}
}
