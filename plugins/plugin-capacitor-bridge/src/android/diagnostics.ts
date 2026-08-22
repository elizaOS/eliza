/**
 * Pure UTF-16 normalization for Android restart diagnostics.
 *
 * This module must remain free of elizaOS and filesystem imports because the
 * Android bridge evaluates it before installing the mobile filesystem shim.
 */

const DIAGNOSTIC_MESSAGE_LIMIT = 2000;
const REPLACEMENT_CHARACTER = "\uFFFD";

/** Normalize lone surrogates and clamp without splitting a valid pair. */
export function formatAndroidFatalDiagnosticMessage(message: string): string {
	let output = "";
	for (let index = 0; index < message.length; index += 1) {
		const codeUnit = message.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const nextCodeUnit = message.charCodeAt(index + 1);
			if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
				if (output.length + 2 > DIAGNOSTIC_MESSAGE_LIMIT) break;
				output += message[index] + message[index + 1];
				index += 1;
				continue;
			}
			if (output.length === DIAGNOSTIC_MESSAGE_LIMIT) break;
			output += REPLACEMENT_CHARACTER;
			continue;
		}
		if (output.length === DIAGNOSTIC_MESSAGE_LIMIT) break;
		output +=
			codeUnit >= 0xdc00 && codeUnit <= 0xdfff
				? REPLACEMENT_CHARACTER
				: message[index];
	}
	return output;
}
