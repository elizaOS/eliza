import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import type { ReleaseSequenceStore } from "../../../usb-installer/src/backend/release-sequence-store";
import {
  type FactoryManifestPolicy,
  verifyFactoryManifest,
} from "./factory-manifest";
import { FactorySourceError } from "./factory-source";
import {
  type LinuxRecoveryStorage,
  validateRecoveryStorageIdentity,
} from "./linux-native-disk";
import type {
  InstallationSourceSelector,
  SelectedInstallationSources,
} from "./prepared-operations";
import { openTrustedInstallDirectory } from "./trusted-directory";
import type { AuthorizedInstallPlan, DiskInventory } from "./types";

export interface DirectoryInstallationSourceOptions {
  /** Service-owned inventory/policy providers. Neither paths nor keys come from IPC. */
  storage(
    plan: AuthorizedInstallPlan,
    inventory: DiskInventory,
    signal?: AbortSignal,
  ): Promise<LinuxRecoveryStorage>;
  policy(): Promise<FactoryManifestPolicy>;
  sequences: ReleaseSequenceStore;
  /** The trusted source catalog's channel, used by the existing sequence store. */
  channel: "stable" | "beta" | "nightly";
}

function fail(message: string, cause?: unknown): FactorySourceError {
  return new FactorySourceError(message, { cause });
}

async function metadata(
  file: FileHandle,
  maximum: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const bytes = Buffer.alloc(maximum + 1);
  let length = 0;
  while (length < bytes.length) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(
      bytes,
      length,
      bytes.length - length,
      length,
    );
    if (!bytesRead) break;
    length += bytesRead;
  }
  if (!length || length > maximum)
    throw fail("Factory metadata exceeds its explicit size bounds.");
  return bytes.subarray(0, length);
}

/** Select regular factory files from independently configured staging storage.
 * Source handles remain anchored to the opened directory through preparation.
 * This authenticates metadata and checks file identities, not payload hashes;
 * PreparedInstallOperationFactory retains the native storage qualification and
 * stageFactorySources verifies every payload byte before publishing it. */
export class DirectoryInstallationSourceSelector
  implements InstallationSourceSelector
{
  constructor(
    private readonly configuration: DirectoryInstallationSourceOptions,
  ) {
    this.configuration = Object.freeze({ ...configuration });
    if (!["stable", "beta", "nightly"].includes(configuration.channel)) {
      throw fail("Factory source channel is invalid.");
    }
  }

  async open(
    plan: AuthorizedInstallPlan,
    inventory: DiskInventory,
    signal?: AbortSignal,
  ): Promise<SelectedInstallationSources> {
    signal?.throwIfAborted();
    plan = structuredClone(plan);
    inventory = structuredClone(inventory);
    const handles: FileHandle[] = [];
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        const errors: unknown[] = [];
        for (const handle of [...handles].reverse()) {
          try {
            await handle.close();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw fail(
            "Factory source handle cleanup failed.",
            new AggregateError(errors),
          );
      })());
    try {
      const storage = structuredClone(
        await this.configuration.storage(
          structuredClone(plan),
          structuredClone(inventory),
          signal,
        ),
      );
      validateRecoveryStorageIdentity(inventory, storage);
      signal?.throwIfAborted();
      const directory = await openTrustedInstallDirectory(
        storage.directoryPath,
        fail,
      );
      handles.push(directory);
      const directoryState = await directory.stat();
      const file = async (name: string, expectedBytes?: number) => {
        signal?.throwIfAborted();
        const handle = await open(
          `/proc/self/fd/${directory.fd}/${name}`,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        handles.push(handle);
        const state = await handle.stat();
        if (
          !state.isFile() ||
          state.uid !== directoryState.uid ||
          state.dev !== directoryState.dev ||
          state.nlink !== 1 ||
          (state.mode & 0o7777) !== 0o600 ||
          (expectedBytes !== undefined && state.size !== expectedBytes)
        ) {
          throw fail(
            "Factory inputs must be private regular files on the staging filesystem with the exact signed size.",
          );
        }
        return handle;
      };
      const manifest = await metadata(
        await file("factory-manifest.json"),
        1024 * 1024,
        signal,
      );
      const signature = await metadata(
        await file("factory-manifest.json.sig"),
        1024,
        signal,
      );
      const suppliedPolicy = await this.configuration.policy();
      const policy = {
        ...suppliedPolicy,
        ...(suppliedPolicy.now ? { now: new Date(suppliedPolicy.now) } : {}),
      };
      const verified = verifyFactoryManifest(manifest, signature, policy);
      const esp = await file(
        "factory-esp.img",
        verified.manifest.esp.sizeBytes,
      );
      const recovery = await file(
        "factory-recovery.img",
        verified.manifest.recovery.sizeBytes,
      );
      signal?.throwIfAborted();
      await this.configuration.sequences.accept({
        [`${this.configuration.channel}/${verified.manifest.architecture}`]:
          verified.manifest.sequence,
      });
      signal?.throwIfAborted();
      return {
        options: {
          manifest,
          signature,
          policy,
          storage,
          sources: {
            esp: { file: esp, offsetBytes: 0 },
            recovery: { file: recovery, offsetBytes: 0 },
          },
          signal,
        },
        close,
      };
    } catch (error) {
      try {
        await close();
      } catch (cleanupError) {
        throw fail(
          "Factory source selection and cleanup failed.",
          new AggregateError([error, cleanupError]),
        );
      }
      throw fail("Factory source selection failed.", error);
    }
  }
}
