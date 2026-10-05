/**
 * Ensures the `window.__electrobun` global exists before Electroview
 * initialisation attempts to write to it. Electrobun's native layer
 * normally sets these globals before preloads run, but in rare edge
 * cases (e.g. the built-in preload hasn't fired yet) we need a stub.
 */
export function ensureElectrobunGlobal(): void {
	if (typeof window.__electrobun === "undefined") {
		(
			window as {
				__electrobun: {
					receiveMessageFromBun: (m: unknown) => void;
					receiveInternalMessageFromBun: (m: unknown) => void;
				};
			}
		).__electrobun = {
			receiveMessageFromBun: (_m: unknown) => {},
			receiveInternalMessageFromBun: (_m: unknown) => {},
		};
	}
}
