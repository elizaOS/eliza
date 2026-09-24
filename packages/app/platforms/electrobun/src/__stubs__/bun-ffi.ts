/**
 * Stub for bun:ffi — used only in Vitest (Vite) test environment.
 * The real bun:ffi is a Bun built-in and is not available when Vitest
 * runs under Node/Vite. All functions return safe no-op values.
 */

export const FFIType = {
	ptr: 0,
	bool: 1,
	f64: 2,
	i32: 3,
	cstring: 4,
	void: 5,
} as const;

export type Pointer = number;

export class CString {
	private readonly value: unknown;
	constructor(ptr: unknown) {
		this.value = ptr;
	}
	toString(): string {
		void this.value;
		return "";
	}
}

export function ptr(_value: ArrayBufferView): Pointer {
	return 0;
}

export function dlopen(
	_path: string,
	_symbols: Record<string, unknown>,
): { symbols: Record<string, (...args: unknown[]) => unknown>; close(): void } {
	return {
		symbols: new Proxy(
			{},
			{
				get:
					(_target, _name) =>
					(..._args: unknown[]) => {
						// All FFI functions return false/null in test environment
						return false;
					},
			},
		),
		close() {},
	};
}
