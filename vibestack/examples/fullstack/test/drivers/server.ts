// How `pnpm check` reaches the HTTP server to compare it with spec/server.md (SPEC.md, "Conformance"): every journey,
// malformed inputs and random walks through POST /api/events, observed as the server saved its state in its file. Each
// trace starts a fresh server on a fresh file.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import type { Driver, Options } from "../../gen/server.conformance.ts";
import { outcome, savedIn, served } from "../served.vibe";

const directory = mkdtempSync(join(tmpdir(), "server-"));
let runs = 0;
const file = () => join(directory, `${runs}.json`);
const start = () => ManagedRuntime.make(Layer.provideMerge(served(file()), NodeServices.layer));
let app = start();

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    await app.dispose();
    runs++;
    app = start();
  },
  dispatch: (_key, event) => app.runPromise(outcome(file(), event)),
  receive: (_key, raw) => app.runPromise(outcome(file(), raw)),
  observe: () => app.runPromise(savedIn(file())),
  [Symbol.asyncDispose]: async () => {
    await app.dispose();
    rmSync(directory, { recursive: true, force: true });
  },
};

/** One server, so one key; a write to disk per request keeps the walks few. */
export const options: Options = { keys: ["server"], walks: 20, steps: 12 };
