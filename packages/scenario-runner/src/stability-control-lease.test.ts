/** Exercises adapter cleanup through the real HTTP control protocol with a deterministic lease clock and failing native preparation. */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createSyntheticControlHandler,
  type JsonValue,
  SyntheticControlProtocolError,
} from "@elizaos/shared/synthetic-control";
import { expect, it } from "vitest";
import { createScenarioStabilityPlan } from "./stability.ts";
import { executeScenarioStability } from "./stability-executor.ts";
import { ScenarioStabilitySubprocessAdapter } from "./stability-subprocess-adapter.ts";

it.each(["valid", "expired", "unsupported"] as const)(
  "resets a long attempt only while its authority lease is valid (expired=%s)",
  async (mode) => {
    const expired = mode === "expired";
    const root = await mkdtemp(path.join(tmpdir(), "stability-lease-"));
    const manifest = {
      version: 1 as const,
      namespace: "lease-duration",
      manifestId: "clock-world",
      domains: {},
    };
    let clock = 0;
    let generation = 0;
    let lease: { id: string; expires: number } | undefined;
    let resets = 0;
    let releases = 0;
    let acquisitions = 0;
    const handler = createSyntheticControlHandler({
      namespace: manifest.namespace,
      token: "lease-duration-test-token",
      authority: {
        generation: () => generation,
        async execute(command, context): Promise<JsonValue> {
          if (command.type === "health") return { status: "ready" };
          if (command.type === "lease.acquire") {
            acquisitions++;
            lease = {
              id: `lease-${generation}`,
              expires: clock + command.ttlMs,
            };
            generation++;
            return { leaseId: lease.id, expiresAt: lease.expires };
          }
          if (
            !lease ||
            context.leaseId !== lease.id ||
            clock >= lease.expires
          ) {
            throw new SyntheticControlProtocolError({
              code: "LEASE_REQUIRED",
              message: "expired test authority lease",
              retryable: false,
              generation,
            });
          }
          if (context.expectedGeneration !== generation)
            throw new Error("stale generation");
          switch (command.type) {
            case "seed":
              generation++;
              return {
                receipt: {
                  version: 1,
                  namespace: manifest.namespace,
                  manifestId: manifest.manifestId,
                  generation,
                  receipt: {},
                },
              };
            case "snapshot":
              return { manifest };
            case "reset":
              resets++;
              generation++;
              return { reset: true };
            case "lease.release":
              releases++;
              generation++;
              lease = undefined;
              return { released: true };
            default:
              throw new Error(`unexpected command ${command.type}`);
          }
        },
      },
    });
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await handler(
        new Request(`http://127.0.0.1${request.url}`, {
          method: request.method,
          headers: Object.fromEntries(
            Object.entries(request.headers).filter(
              (item): item is [string, string] => typeof item[1] === "string",
            ),
          ),
          body: Buffer.concat(chunks),
        }),
      );
      if (!result) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("no server address");
      const adapter = new ScenarioStabilitySubprocessAdapter({
        command: process.execPath,
        args: () => ["-e", "process.exit(99)"],
        cwd: root,
        modelMode: {
          kind: "deterministic-mock",
          fixtureManifestFingerprint: "f".repeat(64),
        },
        syntheticControl: {
          controlUrl: `http://127.0.0.1:${address.port}`,
          controlToken: "lease-duration-test-token",
          manifest,
        },
        nativeAdmission: {
          async prepare() {
            // Advance authority time through execution and cleanup without sleeping or
            // changing the executor's real timeout. No native authority is acquired.
            clock += expired ? 1_230_000 : 1_200_000;
            throw new Error("preparation failed after elapsed budget");
          },
        },
      });
      const report = await executeScenarioStability({
        plan: createScenarioStabilityPlan({
          runId: "lease-budget",
          outputRoot: root,
        }),
        targets: [
          {
            scenarioId: "lease-owner",
            model: { provider: "deterministic", model: "strict-fixtures" },
          },
        ],
        budgets: {
          timeoutMs: mode === "unsupported" ? 86_400_000 : 600_000,
          maxInputTokens: 10,
          maxOutputTokens: 10,
          maxToolCalls: 2,
        },
        adapter,
      });
      const attempts = report.cells[0].attempts;
      expect(attempts.every((attempt) => !attempt.passed)).toBe(true);
      if (mode === "unsupported") {
        expect(acquisitions).toBe(0);
        expect(resets).toBe(0);
        expect(releases).toBe(0);
        expect(attempts[0].error).toContain("exceed the control lease budget");
      } else if (expired) {
        expect(resets).toBe(0);
        expect(releases).toBe(0);
        expect(attempts[0].error).toContain("active control lease");
        expect(attempts[1].error).toContain("quarantined");
      } else {
        expect(resets).toBe(3);
        expect(releases).toBe(3);
        for (const attempt of attempts) {
          expect(attempt.error).toContain(
            "preparation failed after elapsed budget",
          );
          expect(attempt.error).not.toContain("teardown failed");
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
);
