import { randomUUID } from "node:crypto";
import {
  type FactorySourceOptions,
  stageFactorySources,
} from "./factory-source";
import { buildFilesystemImage } from "./filesystem-image";
import type { PlannedPartition } from "./types";

export class InstallPreparationError extends Error {
  readonly code = "ELIZAOS_INSTALL_PREPARATION_ERROR";
}

/** Prepare authenticated images on independent storage before target mutations.
 * The service owns the reviewed plan, source handles, and retained storage session.
 * Failed partials remain available for explicit recovery; no block device is opened
 * for writing here. Reusing an ESP requires a separate preservation-aware backend. */
export async function prepareInstallationFilesystems(
  options: FactorySourceOptions,
  partitions: readonly PlannedPartition[],
  logicalSectorBytes: number,
) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const storage = structuredClone(options.storage);
  const layout = structuredClone(partitions);
  const roles = ["esp", "recovery", "root", "state"] as const;
  if (
    ![512, 4096].includes(logicalSectorBytes) ||
    layout.length !== roles.length ||
    roles.some(
      (role) =>
        layout.filter((partition) => partition.role === role).length !== 1,
    ) ||
    layout.some(
      (partition) =>
        partition.reusePartitionId !== undefined ||
        !Number.isSafeInteger(partition.startBytes) ||
        !Number.isSafeInteger(partition.endBytes) ||
        partition.startBytes < 1024 ** 2 ||
        partition.endBytes <= partition.startBytes ||
        partition.startBytes % 1024 ** 2 !== 0 ||
        partition.endBytes % 1024 ** 2 !== 0 ||
        partition.filesystem !== (partition.role === "esp" ? "fat32" : "ext4"),
    )
  )
    throw new InstallPreparationError(
      "Preparation requires four distinct newly allocated, aligned EFI/ext4 partitions.",
    );
  const ordered = [...layout].sort((a, b) => a.startBytes - b.startBytes);
  if (
    ordered.some(
      (partition, index) =>
        partition.startBytes < (ordered[index - 1]?.endBytes ?? 0),
    )
  )
    throw new InstallPreparationError(
      "Prepared installation partitions overlap.",
    );
  const partition = (role: PlannedPartition["role"]) => {
    const value = layout.find((item) => item.role === role);
    if (!value) throw new InstallPreparationError(`Missing ${role} partition.`);
    return value;
  };
  const staged = await stageFactorySources({ ...options, storage, signal });
  const state = await buildFilesystemImage(
    storage,
    partition("state"),
    logicalSectorBytes,
    signal,
  );
  const recovery = await buildFilesystemImage(
    storage,
    partition("recovery"),
    logicalSectorBytes,
    signal,
    staged.sources.recovery,
  );
  const rootUuid = randomUUID();
  const esp = await buildFilesystemImage(
    storage,
    partition("esp"),
    logicalSectorBytes,
    signal,
    staged.sources.esp,
    {
      ...staged.manifest.boot,
      architecture: staged.manifest.architecture,
      rootUuid,
      recoveryUuid: recovery.uuid,
    },
  );
  const root = await buildFilesystemImage(
    storage,
    partition("root"),
    logicalSectorBytes,
    signal,
    staged.sources.recovery,
    undefined,
    {
      rootUuid,
      homeUuid: state.uuid,
      espUuid: esp.uuid,
    },
  );
  signal?.throwIfAborted();
  const images = { state, recovery, esp, root };
  const uuids = [root.uuid, recovery.uuid, state.uuid];
  if (new Set(uuids).size !== uuids.length || root.uuid !== rootUuid)
    throw new InstallPreparationError(
      "Prepared filesystem identities are ambiguous or changed.",
    );
  for (const image of Object.values(images)) Object.freeze(image);
  return Object.freeze({ ...staged, images: Object.freeze(images) });
}
