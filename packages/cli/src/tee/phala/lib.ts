// Convert hex string to Uint8Array
function hexToUint8Array(hex: string) {
	hex = hex.startsWith("0x") ? hex.slice(2) : hex;
	return new Uint8Array(
		hex.match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
	);
}

function uint8ArrayToHex(buffer: Uint8Array) {
	return Array.from(buffer)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export { hexToUint8Array, uint8ArrayToHex };
