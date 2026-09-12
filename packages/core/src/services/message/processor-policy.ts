/** Defines response processing policy shared by message preparation and delivery. */
import type { Memory } from "../../types/memory";

export function shouldSkipResponseMemoryPersistence(memory: Memory): boolean {
	const content = memory.content as Record<string, unknown> | undefined;
	const metadata = memory.metadata as Record<string, unknown> | undefined;
	return (
		content?.doNotPersist === true ||
		content?.skipMemory === true ||
		content?.transient === true ||
		metadata?.doNotPersist === true ||
		metadata?.skipMemory === true ||
		metadata?.transient === true
	);
}
