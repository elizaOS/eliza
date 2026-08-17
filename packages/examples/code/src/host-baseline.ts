/**
 * Captures the executable-search authority for the ACP child process before
 * any other module body runs. Imported FIRST by the acp entrypoint: ESM
 * evaluates module bodies in import order, so a plain top-of-file call in the
 * entry would run only AFTER every imported runtime/plugin module — too late
 * if one of them mutates process.env. Each ACP child is its own Node process;
 * the host's boot capture (packages/agent bin.ts) does not transfer.
 */
import { captureHostExecutionBaseline } from "@elizaos/shared/host-execution-env";

captureHostExecutionBaseline();
