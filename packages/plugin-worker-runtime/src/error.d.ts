/**
 * Error serialization across the worker boundary.
 *
 * The wire envelope carries a `{ name, message, stack?, cause?, code? }`
 * payload. The receiving side re-throws an `Error` whose `stack`
 * preserves the remote frames and is prefixed with a clearly-marked
 * boundary frame so debuggers can tell where the boundary was crossed.
 */
import type { JsonValue } from "@elizaos/plugin-remote-manifest";
export interface WireError {
    name: string;
    message: string;
    stack?: string;
    cause?: JsonValue;
    code?: string;
}
/** Convert an unknown thrown value into a wire-safe descriptor. */
export declare function toWireError(value: unknown): WireError;
/** Rehydrate a wire descriptor into a thrown-able Error. */
export declare function fromWireError(wire: WireError, boundary: string): Error;
//# sourceMappingURL=error.d.ts.map