/**
 * Low-level transport adapter for the remote-plugin worker runtime.
 *
 * Abstracts the message channel so the same dispatch/proxy code runs on
 * top of a Bun Worker (postMessage / `message` event), a Bun subprocess
 * (stdio newline-delimited JSON), or an HTTPS endpoint (POST /rpc). P1
 * ships the Worker adapter; P2 adds subprocess + HTTPS.
 */
import type { RemotePluginWorkerMessage } from "@elizaos/plugin-remote-manifest";
/** Minimal contract every transport must satisfy. */
export interface WorkerChannel {
  /** Post a message to the host. */
  send(message: RemotePluginWorkerMessage): void;
  /** Subscribe to host → worker messages. Returns an unsubscribe fn. */
  onMessage(handler: (message: RemotePluginWorkerMessage) => void): () => void;
  /** Stop accepting messages and free transport resources. */
  close(): void;
}
/**
 * Worker-thread message-port adapter. Uses `globalThis.postMessage` /
 * `addEventListener("message")` from inside a Web Worker (the model Bun
 * Workers expose).
 */
export declare function createWorkerChannel(): WorkerChannel;
/**
 * Subprocess channel adapter for `isolation: "isolated-process"`. Uses
 * newline-delimited JSON over stdin/stdout. The host
 * (`IsolatedProcessWorkerRunner` in app-core) writes lines into the
 * subprocess's stdin and reads lines from stdout.
 *
 * Bun exposes Node-compatible globals (`process.stdin`, `process.stdout`)
 * inside subprocesses, so we adapt them with the smallest possible
 * surface and feature-detect at construction time.
 */
export declare function createSubprocessChannel(): WorkerChannel;
/**
 * Auto-detect the right channel based on env. Subprocess mode is
 * activated by setting `ELIZA_REMOTE_PLUGIN_CHANNEL=stdio`; otherwise
 * defaults to the Bun-Worker postMessage channel.
 */
export declare function createDefaultChannel(): WorkerChannel;
/**
 * Monotonic request-id allocator used to correlate request / response
 * envelopes. Each side (worker and host) has its own counter and never
 * looks at the other's namespace.
 */
export declare function createRequestIdAllocator(): () => number;
//# sourceMappingURL=envelope.d.ts.map
