declare module "@elizaos/capacitor-llama" {
	export function registerCapacitorLlamaLoader(runtime: {
		registerService?: (name: string, impl: unknown) => unknown;
	}): void;
}
