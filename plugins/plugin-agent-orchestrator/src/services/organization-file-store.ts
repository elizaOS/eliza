/**
 * Persists host-neutral organization aggregates as immutable revision files.
 *
 * Writers publish a complete candidate with an atomic hard link to the next
 * revision name. Competing writers for the same expected revision therefore
 * have one filesystem winner without a reclaimable lock or overwrite window.
 */

import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "@elizaos/core/atomic-json";
import {
  type AgentOrganizationRecord,
  type OrganizationCommandAuthorizer,
  type OrganizationCommandEnvelope,
  type OrganizationCommandResult,
  type OrganizationId,
  type OrganizationStore,
  parseAgentOrganizationRecord,
  sponsorOnlyOrganizationAuthorizer,
  transitionOrganizationRecord,
} from "@elizaos/core/contracts/agent-organization";
import { ElizaError } from "@elizaos/core/errors";
import { logger } from "@elizaos/logger";

export interface FileOrganizationStoreOptions {
  writeAtomic?: (path: string, value: unknown) => Promise<void>;
  publishRevision?: (candidate: string, published: string) => Promise<void>;
  authorize?: OrganizationCommandAuthorizer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

function revisionFileName(revision: number): string {
  return `revision-${revision.toString().padStart(16, "0")}.json`;
}

export class FileOrganizationStore implements OrganizationStore {
  private readonly writeAtomic: (path: string, value: unknown) => Promise<void>;
  private readonly publishRevision: (
    candidate: string,
    published: string,
  ) => Promise<void>;
  private readonly authorize: OrganizationCommandAuthorizer;

  constructor(
    private readonly rootPath: string,
    options: FileOrganizationStoreOptions = {},
  ) {
    this.writeAtomic = options.writeAtomic ?? writeJsonAtomic;
    this.publishRevision = options.publishRevision ?? link;
    this.authorize = options.authorize ?? sponsorOnlyOrganizationAuthorizer;
  }

  private organizationPath(organizationId: OrganizationId): string {
    const digest = createHash("sha256").update(organizationId).digest("hex");
    return join(this.rootPath, digest);
  }

  private async readCurrent(
    organizationId: OrganizationId,
  ): Promise<AgentOrganizationRecord | null> {
    const directory = this.organizationPath(organizationId);
    let names: string[];
    try {
      names = (await readdir(directory))
        .filter((name) => /^revision-\d{16}\.json$/.test(name))
        .sort();
    } catch (error) {
      // error-policy:J2 add aggregate context to filesystem read failures.
      if (errorCode(error) === "ENOENT") return null;
      throw new ElizaError(
        "Organization revision directory could not be read",
        {
          code: "ORGANIZATION_STORE_READ_FAILED",
          cause: error,
          context: { organizationId, directory },
        },
      );
    }
    const latest = names.at(-1);
    if (!latest) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(join(directory, latest), "utf8"),
      ) as unknown;
    } catch (error) {
      // error-policy:J2 a published revision must always be complete JSON.
      throw new ElizaError(
        "Published organization revision is not valid JSON",
        {
          code: "ORGANIZATION_STORE_CORRUPT",
          cause: error,
          context: { organizationId, revisionFile: latest },
          severity: "fatal",
        },
      );
    }
    const record = parseAgentOrganizationRecord(parsed);
    if (record.organization.id !== organizationId) {
      throw new ElizaError("Published organization revision has the wrong id", {
        code: "ORGANIZATION_STORE_CORRUPT",
        context: { expected: organizationId, received: record.organization.id },
        severity: "fatal",
      });
    }
    if (latest !== revisionFileName(record.revision)) {
      throw new ElizaError(
        "Published organization revision filename is inconsistent",
        {
          code: "ORGANIZATION_STORE_CORRUPT",
          context: {
            organizationId,
            revision: record.revision,
            revisionFile: latest,
          },
          severity: "fatal",
        },
      );
    }
    return record;
  }

  async get(
    organizationId: OrganizationId,
  ): Promise<AgentOrganizationRecord | null> {
    const record = await this.readCurrent(organizationId);
    return record ? structuredClone(record) : null;
  }

  async apply(
    envelope: OrganizationCommandEnvelope,
  ): Promise<OrganizationCommandResult> {
    const current = await this.readCurrent(envelope.organizationId);
    const proposed = await transitionOrganizationRecord(
      current,
      envelope,
      this.authorize,
    );
    if (proposed.replayed) return proposed;

    const directory = this.organizationPath(envelope.organizationId);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      // error-policy:J2 preserve directory-preparation failure context.
      throw new ElizaError(
        "Organization revision directory could not be prepared",
        {
          code: "ORGANIZATION_STORE_WRITE_FAILED",
          cause: error,
          context: { organizationId: envelope.organizationId, directory },
        },
      );
    }
    const candidate = join(directory, `.candidate-${randomUUID()}.json`);
    const published = join(
      directory,
      revisionFileName(proposed.record.revision),
    );
    try {
      try {
        await this.writeAtomic(candidate, proposed.record);
      } catch (error) {
        // error-policy:J2 preserve candidate-write failure context.
        throw new ElizaError(
          "Organization revision candidate could not be written",
          {
            code: "ORGANIZATION_STORE_WRITE_FAILED",
            cause: error,
            context: { organizationId: envelope.organizationId, candidate },
          },
        );
      }
      try {
        await this.publishRevision(candidate, published);
      } catch (error) {
        // error-policy:J2 translate publication failures or reconcile the CAS loser.
        if (errorCode(error) !== "EEXIST") {
          throw new ElizaError("Organization revision could not be published", {
            code: "ORGANIZATION_STORE_PUBLISH_FAILED",
            cause: error,
            context: { organizationId: envelope.organizationId, published },
          });
        }
        const winner = await this.readCurrent(envelope.organizationId);
        if (!winner) {
          throw new ElizaError("Organization revision winner disappeared", {
            code: "ORGANIZATION_STORE_CORRUPT",
            context: { organizationId: envelope.organizationId },
            severity: "fatal",
          });
        }
        return await transitionOrganizationRecord(
          winner,
          envelope,
          this.authorize,
        );
      }
      return { record: structuredClone(proposed.record), replayed: false };
    } finally {
      // error-policy:J6 candidate teardown is best effort; only published revision names are read.
      try {
        await rm(candidate, { force: true });
      } catch (error) {
        logger.warn(
          {
            candidate,
            error: error instanceof Error ? error.message : String(error),
          },
          "[FileOrganizationStore] Failed to remove unpublished candidate",
        );
      }
    }
  }
}
