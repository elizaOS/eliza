/** Opens a TCP listener so process-tree teardown tests can detect orphaned descendants. */
import { createServer } from "node:net";

const port = Number(process.env.PROCESS_TREE_LISTENER_PORT);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error("PROCESS_TREE_LISTENER_PORT must be a valid TCP port");
}

const server = createServer();
server.listen(port, "127.0.0.1", () => {
  console.log(`[process-tree-listener] ready pid=${process.pid} port=${port}`);
});
