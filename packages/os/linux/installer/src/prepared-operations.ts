import { createHash } from "node:crypto";
import type { FactorySourceOptions } from "./factory-source";
import { buildFilesystemImage } from "./filesystem-image";
import {
  type LinuxDiskSessionNativeBinding,
  NativeLinuxInstallDiskSession,
} from "./linux-native-disk";
import { prepareInstallationFilesystems } from "./prepare-installation";
import type {
  InstallOperationSession,
  InstallOperationSessionFactory,
} from "./root-service";
import type {
  AuthorizedInstallPlan,
  DiskInventory,
  InstallerAction,
  InstallerActionReceipt,
  PartitionTableBackup,
} from "./types";

/** Service-owned source selection and physical-alias policy, never IPC data. */
export interface SelectedInstallationSources {
  options: FactorySourceOptions;
  close(): Promise<void>;
}
export interface InstallationSourceSelector {
  open(
    plan: AuthorizedInstallPlan,
    inventory: DiskInventory,
    signal?: AbortSignal,
  ): Promise<SelectedInstallationSources>;
}
export class InstallOperationsError extends Error {
  readonly code = "ELIZAOS_INSTALL_OPERATIONS_ERROR";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InstallOperationsError";
  }
}

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Compose filesystem preparation and retained native writes under the service's
 * existing target lock. Source selection must exclude physical aliases and use
 * its durable release-sequence policy. This does not select disks or issue owner
 * credentials, and a write receipt is not firmware boot qualification. */
export class PreparedInstallOperationFactory
  implements InstallOperationSessionFactory
{
  constructor(
    private readonly sources: InstallationSourceSelector,
    private readonly native?: LinuxDiskSessionNativeBinding,
  ) {}

  async open(
    plan: AuthorizedInstallPlan,
    inventory: DiskInventory,
    signal?: AbortSignal,
  ): Promise<InstallOperationSession> {
    plan = structuredClone(plan);
    inventory = structuredClone(inventory);
    signal?.throwIfAborted();
    if (
      plan.actions.some(
        (action) =>
          action.type === "shrink-partition" ||
          action.type === "reuse-esp" ||
          (action.type === "install-bootloader" &&
            action.espPartitionId !== undefined),
      )
    ) {
      throw new InstallOperationsError(
        "Shrinking and reused ESPs require a preservation-aware installation backend.",
      );
    }
    const selected = await this.sources.open(
      structuredClone(plan),
      structuredClone(inventory),
      signal,
    );
    let native: NativeLinuxInstallDiskSession | undefined;
    try {
      signal?.throwIfAborted();
      const options = {
        ...selected.options,
        storage: structuredClone(selected.options.storage),
        signal,
      };
      native = new NativeLinuxInstallDiskSession(
        plan,
        inventory,
        options.storage,
        this.native,
      );
      // Keep the native storage qualification live throughout preparation.
      const prepared = await prepareInstallationFilesystems(
        options,
        plan.partitions,
        inventory.logicalSectorBytes,
      );
      const partition = (role: "root" | "esp") => {
        const value = plan.partitions.find((item) => item.role === role);
        if (!value)
          throw new InstallOperationsError(`Missing ${role} partition.`);
        return value;
      };
      // Creation establishes the filesystem. Later install actions perform the
      // actual root and boot-payload writes and return their own native receipts.
      const emptyRoot = await buildFilesystemImage(
        options.storage,
        partition("root"),
        inventory.logicalSectorBytes,
        signal,
      );
      const emptyEsp = await buildFilesystemImage(
        options.storage,
        partition("esp"),
        inventory.logicalSectorBytes,
        signal,
      );
      signal?.throwIfAborted();
      const session = native;
      let backup: PartitionTableBackup | undefined;
      let nextAction = 0;
      let failed = false;
      let closing = false;
      let settled: Promise<void> | undefined;
      let closingPromise: Promise<void> | undefined;
      const run = <T>(operation: () => Promise<T>): Promise<T> => {
        if (closing || settled || failed)
          return Promise.reject(
            new InstallOperationsError(
              "Installation session is closing, busy, or requires recovery.",
            ),
          );
        const promise = Promise.resolve().then(async () => {
          signal?.throwIfAborted();
          const result = await operation();
          signal?.throwIfAborted();
          return result;
        });
        // The returned promise preserves the operation error; close only waits
        // for settlement before releasing the held native descriptors.
        settled = promise.then(
          () => {
            settled = undefined;
          },
          () => {
            failed = true;
            settled = undefined;
          },
        );
        return promise;
      };
      return {
        backupPartitionTable: (current) => {
          current = structuredClone(current);
          return run(async () => {
            const value = await session.backupPartitionTable(current);
            backup = structuredClone(value);
            return value;
          });
        },
        verifyPartitionTableBackup: (value, current) => {
          value = structuredClone(value);
          current = structuredClone(current);
          return run(async () => {
            const verified = await session.verifyPartitionTableBackup(
              value,
              current,
            );
            if (!verified)
              throw new InstallOperationsError(
                "Native backup verification failed.",
              );
            backup = structuredClone(value);
            return true;
          });
        },
        apply: (input, current) => {
          const action: InstallerAction = structuredClone(input);
          current = structuredClone(current);
          return run(async (): Promise<InstallerActionReceipt> => {
            if (
              !backup ||
              JSON.stringify(action) !==
                JSON.stringify(plan.actions[nextAction])
            )
              throw new InstallOperationsError(
                "Installation action is not the next reviewed action with a verified backup.",
              );
            const effects: unknown[] = [];
            switch (action.type) {
              case "erase-partition-table":
                effects.push(
                  await session.applyGptEdit(action, current, backup),
                );
                break;
              case "create-partition": {
                effects.push(
                  await session.applyGptEdit(action, current, backup),
                );
                signal?.throwIfAborted();
                const role = action.partition.role;
                const image =
                  role === "root"
                    ? emptyRoot
                    : role === "esp"
                      ? emptyEsp
                      : prepared.images[role];
                effects.push(
                  await session.writePartitionImage(
                    action.partition,
                    image,
                    current,
                    backup,
                    signal,
                  ),
                );
                break;
              }
              case "install-system":
                effects.push(
                  await session.writePartitionImage(
                    {
                      startBytes: action.rootStartBytes,
                      endBytes: action.rootEndBytes,
                    },
                    prepared.images.root,
                    current,
                    backup,
                    signal,
                  ),
                );
                break;
              case "install-bootloader":
                effects.push(
                  await session.writePartitionImage(
                    partition("esp"),
                    prepared.images.esp,
                    current,
                    backup,
                    signal,
                  ),
                );
                break;
              default:
                throw new InstallOperationsError(
                  `Unsupported installation action: ${action.type}`,
                );
            }
            signal?.throwIfAborted();
            nextAction++;
            const actionDigest = digest(action);
            return {
              actionDigest,
              receiptId: digest({
                domain: "elizaos-install-action-v1",
                planId: plan.planId,
                actionDigest,
                effects,
              }),
            };
          });
        },
        close: () => {
          closing = true;
          closingPromise ??= (async () => {
            await settled;
            const errors: unknown[] = [];
            try {
              await session.close();
            } catch (error) {
              errors.push(error);
            }
            try {
              await selected.close();
            } catch (error) {
              errors.push(error);
            }
            if (errors.length)
              throw new InstallOperationsError(
                "Installation resource cleanup failed.",
                { cause: new AggregateError(errors) },
              );
          })();
          return closingPromise;
        },
      };
    } catch (error) {
      const errors = [error];
      try {
        await native?.close();
      } catch (failure) {
        errors.push(failure);
      }
      try {
        await selected.close();
      } catch (failure) {
        errors.push(failure);
      }
      throw new InstallOperationsError(
        "Installation preparation failed before target mutation.",
        { cause: new AggregateError(errors) },
      );
    }
  }
}
