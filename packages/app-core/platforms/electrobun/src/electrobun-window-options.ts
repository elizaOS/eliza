import { BrowserWindow } from "electrobun/bun";

type BrowserWindowConstructorOptions = NonNullable<
	ConstructorParameters<typeof BrowserWindow>[0]
>;

export type ElectrobunBrowserWindowOptions = BrowserWindowConstructorOptions & {
	/**
	 * Supported by Electrobun runtime builds used by the desktop app, but not
	 * present in the published 1.18 BrowserWindow constructor type.
	 */
	icon?: string;
	/**
	 * Supported by the native webview/session layer. BrowserView already types
	 * this field; BrowserWindow's constructor type has not caught up.
	 */
	partition?: string | null;
};

export function createElectrobunBrowserWindow(
	options: ElectrobunBrowserWindowOptions,
): BrowserWindow {
	const constructorOptions: BrowserWindowConstructorOptions = options;
	return new BrowserWindow(constructorOptions);
}
