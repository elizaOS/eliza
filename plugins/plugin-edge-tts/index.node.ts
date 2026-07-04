/** Node build entrypoint; re-exports the node plugin implementation. */
import edgeTTSPlugin from "./src/index";

export * from "./src/index.node";
export default edgeTTSPlugin;
