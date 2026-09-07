/** Exercises a persisted FILE continuation in a fresh process using real sandbox and file services. */
import { setupEnv } from "../src/actions/__tests__/helpers.js";
import { readFileHandler } from "../src/actions/read.js";

const input = JSON.parse(process.argv[2]) as {
  workspace: string;
  reference: string;
  revision: string;
  conversationId?: string;
  blockedPath?: string;
};
const env = await setupEnv("file-reference-child", {
  rootsPath: input.workspace,
  blockedPath: input.blockedPath,
});
const result = await readFileHandler(
  env.runtime,
  {
    ...env.message,
    ...(input.conversationId ? { roomId: input.conversationId } : {}),
  },
  undefined,
  {
    parameters: {
      reference: input.reference,
      expectedRevision: input.revision,
      offset: 1,
      limit: 1,
    },
  },
);
await env.sandbox.stop();
await env.fileState.stop();
await env.sessionCwd.stop();
process.stdout.write(`${JSON.stringify(result)}\n`);
