/**
 * Pins the privacy and failure semantics of the Cloud liveness diagnostic
 * writer without touching the filesystem or a live provider.
 */

import { describe, expect, it, vi } from "vitest";

import {
  LIVENESS_DIAGNOSTIC_ARTIFACT_FIELDS,
  LIVENESS_DIAGNOSTIC_ARTIFACT_SCHEMA,
  LIVENESS_DIAGNOSTIC_WRITE_FAILURE_ANNOTATION,
  writePrivacySafeLivenessDiagnostic,
} from "./privacy-safe-liveness-diagnostic-artifact.mjs";

describe("privacy-safe liveness diagnostic artifact", () => {
  it("writes the exact closed schema with private file permissions", async () => {
    const mkdirFn = vi.fn(async () => undefined);
    let writtenPath: string | undefined;
    let writtenData = "";
    let writtenOptions:
      | { encoding: string; flag: string; mode: number }
      | undefined;
    const writeFileFn = vi.fn(
      async (
        path: string,
        data: string,
        options: { encoding: string; flag: string; mode: number },
      ) => {
        writtenPath = path;
        writtenData = data;
        writtenOptions = options;
      },
    );
    const annotations: Array<{ type: string; description: string }> = [];
    const allowedRecord = Object.fromEntries(
      LIVENESS_DIAGNOSTIC_ARTIFACT_FIELDS.map((field, index) => [
        field,
        field === "originalErrorName"
          ? "AssertionError"
          : field === "assistantPhase"
            ? "reply"
            : field.endsWith("Delta") || field.endsWith("Count")
              ? index
              : index % 2 === 0,
      ]),
    );
    const privateMarker = "private-transcript-must-not-escape";
    const diagnosticRecord = Object.defineProperties(
      {
        ...allowedRecord,
        schema: "caller-must-not-override-the-closed-schema",
        assistantHasText: { privateMarker },
        provider: "private-provider",
        path: "/private/path",
        token: "private-token",
      },
      {
        transcript: {
          enumerable: true,
          get: () => {
            throw new Error(privateMarker);
          },
        },
      },
    ) as unknown as Record<string, string | number | boolean | null>;

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
    expect(writeFileFn).toHaveBeenCalledOnce();
    expect(writtenPath).toBe("/tmp/eliza-run/diagnostic.json");
    expect(writtenOptions).toEqual({
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const expectedRecord = { ...allowedRecord };
    delete expectedRecord.assistantHasText;
    expect(JSON.parse(writtenData)).toEqual({
      ...expectedRecord,
      schema: LIVENESS_DIAGNOSTIC_ARTIFACT_SCHEMA,
    });
    expect(writtenData).not.toContain(privateMarker);
    expect(writtenData).not.toContain("private-provider");
    expect(writtenData).not.toContain("/private/path");
    expect(writtenData).not.toContain("private-token");
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
