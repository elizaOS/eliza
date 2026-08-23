/**
 * Pins the privacy and failure semantics of the Cloud liveness diagnostic
 * writer without touching the filesystem or a live provider.
 */

import { describe, expect, it, vi } from "vitest";

import {
  LIVENESS_DIAGNOSTIC_ARTIFACT_SCHEMA,
  LIVENESS_DIAGNOSTIC_WRITE_FAILURE_ANNOTATION,
  writePrivacySafeLivenessDiagnostic,
} from "./privacy-safe-liveness-diagnostic-artifact.mjs";

describe("privacy-safe liveness diagnostic artifact", () => {
  it("writes the exact closed schema with private file permissions", async () => {
    const mkdirFn = vi.fn(async () => undefined);
    const writeFileFn = vi.fn(async () => undefined);
    const annotations: Array<{ type: string; description: string }> = [];
    const diagnosticRecord = {
      historyGetDelta: 1,
      retryObservationAvailable: true,
      phase: "terminal",
    };

    await expect(
      writePrivacySafeLivenessDiagnostic({
        diagnosticPath: "/tmp/eliza-run/diagnostic.json",
        diagnosticRecord,
        annotations,
        mkdirFn,
        writeFileFn,
      }),
    ).resolves.toBe(true);

    expect(mkdirFn).toHaveBeenCalledWith("/tmp/eliza-run", {
      recursive: true,
      mode: 0o700,
    });
    expect(writeFileFn).toHaveBeenCalledWith(
      "/tmp/eliza-run/diagnostic.json",
      `${JSON.stringify(
        {
          schema: LIVENESS_DIAGNOSTIC_ARTIFACT_SCHEMA,
          ...diagnosticRecord,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    expect(annotations).toEqual([]);
  });

  it.each(["directory creation", "exclusive artifact write"])(
    "reports %s failure without retaining the rejected value",
    async (boundary) => {
      const privateMarker = "private-model-output-must-not-escape";
      const hostileRejection = Object.defineProperties(
        {},
        {
          message: {
            get: () => {
              throw new Error(privateMarker);
            },
          },
          toString: {
            value: () => {
              throw new Error(privateMarker);
            },
          },
        },
      );
      const mkdirFn = vi.fn(async () => {
        if (boundary === "directory creation") {
          throw hostileRejection;
        }
      });
      const writeFileFn = vi.fn(async () => {
        if (boundary === "exclusive artifact write") {
          throw hostileRejection;
        }
      });
      const annotations: Array<{ type: string; description: string }> = [];

      await expect(
        writePrivacySafeLivenessDiagnostic({
          diagnosticPath: "/tmp/eliza-run/diagnostic.json",
          diagnosticRecord: { phase: "terminal" },
          annotations,
          mkdirFn,
          writeFileFn,
        }),
      ).resolves.toBe(false);

      expect(annotations).toEqual([
        LIVENESS_DIAGNOSTIC_WRITE_FAILURE_ANNOTATION,
      ]);
      expect(JSON.stringify(annotations)).not.toContain(privateMarker);
    },
  );

  it("does not let an unavailable annotation sink replace the primary verdict", async () => {
    const annotations = Object.freeze([]);

    await expect(
      writePrivacySafeLivenessDiagnostic({
        diagnosticPath: "/tmp/eliza-run/diagnostic.json",
        diagnosticRecord: { phase: "terminal" },
        annotations,
        mkdirFn: async () => {
          throw new Error("write unavailable");
        },
      }),
    ).resolves.toBe(false);
  });
});
