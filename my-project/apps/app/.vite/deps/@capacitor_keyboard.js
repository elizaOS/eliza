import { registerPlugin } from "./@capacitor_core.js";
//#region ../../node_modules/@capacitor/keyboard/dist/esm/definitions.js
var KeyboardStyle;
(function(KeyboardStyle) {
	/**
	* Dark keyboard.
	*
	* @since 1.0.0
	*/
	KeyboardStyle["Dark"] = "DARK";
	/**
	* Light keyboard.
	*
	* @since 1.0.0
	*/
	KeyboardStyle["Light"] = "LIGHT";
	/**
	* The keyboard style is based on the device appearance.
	* If the device is using Dark mode, the keyboard will be dark.
	* If the device is using Light mode, the keyboard will be light.
	*
	* @since 1.0.0
	*/
	KeyboardStyle["Default"] = "DEFAULT";
})(KeyboardStyle || (KeyboardStyle = {}));
var KeyboardResize;
(function(KeyboardResize) {
	/**
	* Only the `body` HTML element will be resized.
	* Relative units are not affected, because the viewport does not change.
	*
	* @since 1.0.0
	*/
	KeyboardResize["Body"] = "body";
	/**
	* Only the `ion-app` HTML element will be resized.
	* Use it only for Ionic Framework apps.
	*
	* @since 1.0.0
	*/
	KeyboardResize["Ionic"] = "ionic";
	/**
	* The whole native Web View will be resized when the keyboard shows/hides.
	* This affects the `vh` relative unit.
	*
	* @since 1.0.0
	*/
	KeyboardResize["Native"] = "native";
	/**
	* Neither the app nor the Web View are resized.
	*
	* @since 1.0.0
	*/
	KeyboardResize["None"] = "none";
})(KeyboardResize || (KeyboardResize = {}));
//#endregion
//#region ../../node_modules/@capacitor/keyboard/dist/esm/index.js
var Keyboard = registerPlugin("Keyboard");
//#endregion
export { Keyboard, KeyboardResize, KeyboardStyle };
