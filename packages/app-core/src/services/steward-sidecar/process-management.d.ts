/**
 * Find the Steward API entry point on disk.
 */
export declare function findStewardEntryPoint(): Promise<string | null>;
/**
 * Pipe a ReadableStream to the structured logger, calling onLog for each line.
 */
export declare function pipeOutput(stream: ReadableStream<Uint8Array> | null, name: "stdout" | "stderr", onLog?: (line: string, stream: "stdout" | "stderr") => void): Promise<void>;
//# sourceMappingURL=process-management.d.ts.map