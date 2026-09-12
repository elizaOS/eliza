/** Runs the actual child transport for IPC lifecycle tests against a parent process. */
import { createDevTrajectoryRecoveryIpc } from "../../../src/runtime/dev-trajectory-recovery-ipc.ts";

const transport = createDevTrajectoryRecoveryIpc(process, 300);
process.on("message", async (message) => {
  if (message?.qa !== "prepare") return;
  try {
    const registered = await transport.registerOwner(message.owner);
    await transport.acknowledgeRecovery(registered.recoveryBatchId);
    process.send({ qa: "result", owners: registered.owners });
  } catch (error) {
    // error-policy:J1 The fixture reports the real transport failure to its test.
    if (!process.connected) process.exit(23);
    process.send({ qa: "result", error: error.message });
  }
});
process.send({
  qa: "ready",
  runtime: process.versions.bun ? "Bun" : "Node",
  version: process.versions.bun ?? process.versions.node,
});
