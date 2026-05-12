/**
 * Stub for electrobun/bun — used only in Vitest (Vite) test environment.
 * The real electrobun/bun is a native Bun module and is not available when
 * Vitest runs under Node/Vite.
 */

export const Utils = {
	quit: () => {},
};

export const BrowserWindow = {};
export const BrowserView = {};
export const ApplicationMenu = {};
export const BuildConfig = {};
export const Updater = {};
export const WGPU = {};
export const webgpu = {};
export const Electrobun = { events: { on: () => {} } };

export default Electrobun;
