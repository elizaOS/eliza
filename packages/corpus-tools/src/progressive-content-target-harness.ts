/**
 * Drives one verified corpus through the shared six-family production target
 * contract and emits observed realization, conformance, source-work, and
 * lifecycle receipts from the same target instances.
 */

import type {
  ProgressiveContentConformanceReport,
  ProgressiveContentTarget,
  ProgressiveContentTargetFactory,
  ProgressiveContentTargetReceipt,
} from "@elizaos/core/testing";
import {
  PROGRESSIVE_CONTENT_TARGET_FAMILIES,
  runProgressiveContentTargetConformance,
} from "@elizaos/core/testing";
import type {
  ProgressiveContentFamily,
  ProgressiveContentManifest,
  ProgressiveContentObject,
} from "./progressive-content.ts";
import {
  openProgressiveContentBoundedSource,
  type ProgressiveNativeRealizationEntry,
  type ProgressiveSourceWork,
} from "./progressive-content-realization.ts";

export const PROGRESSIVE_CONTENT_TARGET_HARNESS_SCHEMA_VERSION =
  "elizaos.progressive-content.target-harness.v1" as const;

export interface ProgressiveContentTargetHarnessEntry {
  readonly objectId: string;
  readonly family: ProgressiveContentFamily;
  readonly adapterId: string;
  readonly status: "verified" | "failed";
  readonly sourceSha256: string;
  readonly sourceRevision: string;
  readonly nativeRevision?: string;
  readonly sourceBytes: number;
  readonly sourceWork: ProgressiveSourceWork;
  readonly realization?: ProgressiveNativeRealizationEntry;
  readonly conformance?: ProgressiveContentConformanceReport;
  readonly receipts?: readonly ProgressiveContentTargetReceipt[];
  readonly code?: string;
  readonly blocker?: string;
}

export interface ProgressiveContentTargetHarnessReport {
  readonly schemaVersion: typeof PROGRESSIVE_CONTENT_TARGET_HARNESS_SCHEMA_VERSION;
  readonly corpusManifestSha256: string;
  readonly generatorRevision: string;
  readonly status: "passed" | "failed";
  readonly factories: readonly {
    readonly family: ProgressiveContentFamily;
    readonly adapterId: string;
    readonly authoritativeStore: ProgressiveContentTargetFactory["authoritativeStore"];
    readonly productionMethod: string;
    readonly binaryPolicy: ProgressiveContentTargetFactory["binaryPolicy"];
  }[];
  readonly entries: readonly ProgressiveContentTargetHarnessEntry[];
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "PROGRESSIVE_TARGET_FAILED";
}

function validateFactories(
  factories: readonly ProgressiveContentTargetFactory[],
): Map<ProgressiveContentFamily, ProgressiveContentTargetFactory> {
  if (factories.length !== PROGRESSIVE_CONTENT_TARGET_FAMILIES.length) {
    throw new TypeError("target harness requires exactly six factories");
  }
  const byFamily = new Map<
    ProgressiveContentFamily,
    ProgressiveContentTargetFactory
  >();
  for (const factory of factories) {
    if (
      !PROGRESSIVE_CONTENT_TARGET_FAMILIES.includes(factory.family) ||
      byFamily.has(factory.family) ||
      !factory.adapterId ||
      !factory.productionMethod
    ) {
      throw new TypeError(
        "target factory declaration is invalid or duplicated",
      );
    }
    byFamily.set(factory.family, factory);
  }
  return byFamily;
}

function realizationEntry(input: {
  object: ProgressiveContentObject;
  adapterId: string;
  target: Awaited<ReturnType<ProgressiveContentTargetFactory["create"]>>;
  sourceWork: ProgressiveSourceWork;
}): ProgressiveNativeRealizationEntry {
  return {
    objectId: input.object.id,
    family: input.object.family,
    adapterId: input.adapterId,
    status: "verified",
    sourceSha256: input.object.sourceSha256,
    sourceBytes: input.object.byteLength,
    sourceWork: input.sourceWork,
    reference: {
      kind: input.target.realization.reference.kind,
      ref: input.target.realization.reference.ref,
    },
    revision: input.target.object.revision,
    authorizationScope: input.object.authorizationScope,
    cleanupIdentity: input.target.realization.cleanupIdentity,
    resolverBindingSha256: input.target.realization.resolverBindingSha256,
  };
}

/** Execute every manifest object through exactly one native production factory. */
export async function runProgressiveContentTargetHarness(input: {
  readonly corpusRoot: string;
  readonly manifest: ProgressiveContentManifest;
  readonly factories: readonly ProgressiveContentTargetFactory[];
}): Promise<ProgressiveContentTargetHarnessReport> {
  const factories = validateFactories(input.factories);
  const entries: ProgressiveContentTargetHarnessEntry[] = [];
  for (const object of input.manifest.objects) {
    const factory = factories.get(object.family);
    if (!factory) throw new TypeError(`factory is absent for ${object.family}`);
    const opened = await openProgressiveContentBoundedSource(
      input.corpusRoot,
      object,
    );
    let target: ProgressiveContentTarget | undefined;
    try {
      target = await factory.create({
        object: {
          id: object.id,
          family: object.family,
          byteLength: object.byteLength,
          sourceSha256: object.sourceSha256,
          sourceRevision: object.revision,
          format: object.format,
          authorizationScope: object.authorizationScope,
          canaries: object.canaries,
        },
        source: opened.source,
      });
      if (!opened.exactCoverage()) {
        await target.cleanup();
        throw new Error(`factory did not consume ${object.id} exactly once`);
      }
      const result = await runProgressiveContentTargetConformance({
        manifestSha256: input.manifest.manifestSha256,
        adapterId: factory.adapterId,
        target,
      });
      const sourceWork = opened.source.work();
      entries.push({
        objectId: object.id,
        family: object.family,
        adapterId: factory.adapterId,
        status: result.report.status === "passed" ? "verified" : "failed",
        sourceSha256: object.sourceSha256,
        sourceRevision: object.revision,
        nativeRevision: target.object.revision,
        sourceBytes: object.byteLength,
        sourceWork,
        realization: realizationEntry({
          object,
          adapterId: factory.adapterId,
          target,
          sourceWork,
        }),
        conformance: result.report,
        receipts: result.receipts,
        ...(result.report.status === "failed"
          ? {
              code: "PROGRESSIVE_TARGET_CONFORMANCE_FAILED",
              blocker: result.report.failures
                .map(({ vector, message }) => `${vector}: ${message}`)
                .join("; "),
            }
          : {}),
      });
    } catch (error) {
      let cleanupFailure: string | undefined;
      if (target) {
        try {
          await target.cleanup();
        } catch (cleanupError) {
          // error-policy:J6 failed-run teardown is retained in failed evidence.
          cleanupFailure =
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError);
        }
      }
      entries.push({
        objectId: object.id,
        family: object.family,
        adapterId: factory.adapterId,
        status: "failed",
        sourceSha256: object.sourceSha256,
        sourceRevision: object.revision,
        sourceBytes: object.byteLength,
        sourceWork: opened.source.work(),
        code: errorCode(error),
        blocker: [
          error instanceof Error ? error.message : String(error),
          ...(cleanupFailure ? [`cleanup: ${cleanupFailure}`] : []),
        ].join("; "),
      });
    } finally {
      await opened.close();
    }
  }
  return {
    schemaVersion: PROGRESSIVE_CONTENT_TARGET_HARNESS_SCHEMA_VERSION,
    corpusManifestSha256: input.manifest.manifestSha256,
    generatorRevision: input.manifest.generatorRevision,
    status: entries.every(({ status }) => status === "verified")
      ? "passed"
      : "failed",
    factories: PROGRESSIVE_CONTENT_TARGET_FAMILIES.map((family) => {
      const factory = factories.get(family);
      if (!factory) throw new TypeError(`factory is absent for ${family}`);
      return {
        family,
        adapterId: factory.adapterId,
        authoritativeStore: factory.authoritativeStore,
        productionMethod: factory.productionMethod,
        binaryPolicy: factory.binaryPolicy,
      };
    }),
    entries,
  };
}
