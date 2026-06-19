/**
 * E2E build helper — drives the REAL AppImageBuilder against local Docker so the
 * build pipeline's impure executor is verified end-to-end (not mocked). The
 * `exec` seam runs `sudo sh -c <docker build ...>` locally; in production the
 * same builder runs over SSH to a builder node.
 *
 * Env: REGISTRY, APP_ID, CONTEXT (build dir), DOCKERFILE (optional).
 */

import { spawn } from "node:child_process";
import { AppImageBuilder, type BuildExec } from "../src/lib/services/app-image-builder";

const localExec: BuildExec = {
  exec: (command) =>
    new Promise<string>((resolve, reject) => {
      const p = spawn("sudo", ["sh", "-c", command], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => {
        out += d;
      });
      p.stderr.on("data", (d) => {
        out += d;
      });
      p.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new Error(`build exit ${code}:\n${out.slice(-800)}`)),
      );
    }),
};

const res = await new AppImageBuilder({ exec: localExec }).build({
  registry: process.env.REGISTRY!,
  appId: process.env.APP_ID!,
  context: process.env.CONTEXT!,
  dockerfile: process.env.DOCKERFILE || undefined,
});

process.stderr.write(`${res.buildOutput.slice(-300)}\n`);
process.stdout.write(res.imageRef);
process.exit(0);
