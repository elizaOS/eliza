/**
 * Executable safety model for the native Linux Restore helper. This is not a
 * device inventory implementation and never authorizes a restore. It captures
 * the FD/identity invariants that the native boundary and its adversarial tests
 * must preserve while the UI capability remains disabled.
 */
export interface RestoreBlockIdentity {
  major: bigint;
  minor: bigint;
  diskseq: bigint;
  sizeBytes: bigint;
}

export interface RestorePartitionIdentity extends RestoreBlockIdentity {
  partitionNumber: 1;
  parentMajor: bigint;
  parentMinor: bigint;
}

export interface HeldRestoreTarget {
  readonly fdSlot: 3;
  readonly identity: RestoreBlockIdentity;
}

export interface HeldRestorePartition {
  readonly fdSlot: 4;
  readonly identity: RestorePartitionIdentity;
}

export const RESTORE_WHOLE_DEVICE_OPEN_FLAGS = [
  "O_RDWR",
  "O_CLOEXEC",
  "O_NOFOLLOW",
  "O_EXCL",
] as const;

/**
 * The retained whole-device claim is the exclusive claim for the operation.
 * A partition of that disk must not request a second O_EXCL claim with a
 * distinct file holder: Linux rejects that combination with EBUSY.
 */
export const RESTORE_PARTITION_OPEN_FLAGS = [
  "O_RDWR",
  "O_CLOEXEC",
  "O_NOFOLLOW",
] as const;

export class RestorePlanUseRegistry {
  readonly #used = new Set<string>();
  readonly #bootId: string;

  constructor(bootId: string) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)) {
      throw new Error("Restore boot identifier is not canonical.");
    }
    this.#bootId = bootId;
  }

  consume(planId: string, bootId: string): void {
    if (!/^[a-f0-9]{32}$/.test(planId)) {
      throw new Error("Restore plan identifier is not canonical.");
    }
    if (bootId !== this.#bootId) {
      throw new Error("Restore plan belongs to a different system boot.");
    }
    if (this.#used.has(planId)) {
      throw new Error("Restore plan was already consumed.");
    }
    this.#used.add(planId);
  }
}

export interface RestoreFdQualificationProbe {
  readonly executable: "/usr/bin/stat";
  readonly argv: readonly ["stat", "--format=%t:%T", `/proc/self/fd/${3 | 4}`];
  readonly inheritedFd: 3 | 4;
}

export type RestoreMutationTool =
  | "settle-udev"
  | "format-exfat"
  | "verify-exfat";

export interface RestoreMutationToolInvocation {
  readonly executable:
    | "/usr/bin/udevadm"
    | "/usr/libexec/elizaos-mkfs-exfat-fd"
    | "/usr/libexec/elizaos-fsck-exfat-fd";
  readonly argv: readonly string[];
  readonly inheritedFds: readonly (3 | 4)[];
}

export const RESTORE_MUTATION_CHILD_POLICY = {
  environment: { LANG: "C", LC_ALL: "C", PATH: "/nonexistent" },
  standardInput: "null",
  timeoutMs: 15_000,
  killSignal: "SIGKILL",
  maxOutputBytesPerStream: 256 * 1024,
} as const;

/** Internal libfdisk operation on the held FD, never a pathname-based child. */
export const RESTORE_GPT_NATIVE_API = {
  create: "elizaos_restore_create_gpt",
  verify: "elizaos_restore_verify_gpt",
} as const;

/**
 * Candidate native process shapes. They are intentionally data only: the
 * shipped helper does not execute them until the same exact binaries have
 * passed privileged block-device qualification and packaging review.
 */
export const RESTORE_MUTATION_TOOLS: Readonly<
  Record<RestoreMutationTool, RestoreMutationToolInvocation>
> = {
  "settle-udev": {
    executable: "/usr/bin/udevadm",
    argv: ["udevadm", "settle", "--timeout=10"],
    inheritedFds: [],
  },
  "format-exfat": {
    executable: "/usr/libexec/elizaos-mkfs-exfat-fd",
    argv: ["elizaos-mkfs-exfat-fd"],
    inheritedFds: [4],
  },
  "verify-exfat": {
    executable: "/usr/libexec/elizaos-fsck-exfat-fd",
    argv: ["elizaos-fsck-exfat-fd"],
    inheritedFds: [4],
  },
} as const;

export const RESTORE_MUTATION_ORCHESTRATION = [
  "check-cancel",
  "validate-whole",
  "consume-plan",
  "validate-whole",
  "check-cancel",
  "run-create-gpt",
  "validate-whole",
  "check-cancel",
  "run-verify-gpt",
  "validate-whole",
  "check-cancel",
  "kernel-reread-partitions",
  "validate-whole",
  "check-cancel",
  "run-settle-udev",
  "validate-whole",
  "check-cancel",
  "retain-and-bind-partition-1",
  "validate-whole-and-partition",
  "check-cancel",
  "run-format-exfat",
  "validate-whole-and-partition",
  "check-cancel",
  "run-verify-exfat",
  "validate-whole-and-partition",
  "check-cancel",
  "sync-whole-and-partition",
  "validate-whole-and-partition",
  "complete",
] as const;

export type RestoreMutationStep =
  | "authorized"
  | "plan-consumed"
  | "gpt-created"
  | "gpt-verified"
  | "kernel-reread"
  | "udev-settled"
  | "partition-retained"
  | "exfat-formatted"
  | "exfat-verified"
  | "media-synced"
  | "complete";

export type RestoreMutationTerminal =
  | { readonly status: "complete" }
  | {
      readonly status: "cancelled" | "failed";
      readonly mediaState: "untouched" | "incomplete";
      readonly lastCompletedStep: RestoreMutationStep;
    };

const RESTORE_MUTATION_STEPS: readonly RestoreMutationStep[] = [
  "authorized",
  "plan-consumed",
  "gpt-created",
  "gpt-verified",
  "kernel-reread",
  "udev-settled",
  "partition-retained",
  "exfat-formatted",
  "exfat-verified",
  "media-synced",
  "complete",
];

/**
 * Models the fail-closed native sequencing contract. Cancellation is checked
 * between bounded child operations. Once replay-marker creation is attempted,
 * cancellation or any failure is terminal `incomplete`, never success.
 */
export class RestoreMutationSequence {
  #index = 0;
  #consumptionAttempted = false;
  #terminal: RestoreMutationTerminal | undefined;

  get current(): RestoreMutationStep {
    const current = RESTORE_MUTATION_STEPS[this.#index];
    if (!current) throw new Error("Restore mutation state is invalid.");
    return current;
  }

  beginConsumption(): void {
    if (this.#terminal || this.#index !== 0 || this.#consumptionAttempted)
      throw new Error("Restore plan consumption cannot be attempted again.");
    this.#consumptionAttempted = true;
  }

  advance(next: RestoreMutationStep): void {
    if (this.#terminal)
      throw new Error("Restore mutation is already terminal.");
    if (next !== RESTORE_MUTATION_STEPS[this.#index + 1]) {
      throw new Error("Restore mutation step is out of order.");
    }
    if (next === "plan-consumed") this.#consumptionAttempted = true;
    this.#index += 1;
    if (next === "complete") this.#terminal = { status: "complete" };
  }

  terminate(status: "cancelled" | "failed"): RestoreMutationTerminal {
    if (this.#terminal)
      throw new Error("Restore mutation is already terminal.");
    const lastCompletedStep = this.current;
    this.#terminal = {
      status,
      mediaState: this.#consumptionAttempted ? "incomplete" : "untouched",
      lastCompletedStep,
    };
    return this.#terminal;
  }

  result(): RestoreMutationTerminal | undefined {
    return this.#terminal;
  }
}

/**
 * Returns the only process shape currently modeled for a retained Restore FD.
 * It is deliberately a non-mutating qualification probe, not a restore tool.
 * No shell, PATH lookup, caller-supplied argv, or device pathname is accepted.
 */
export function restoreFdQualificationProbe(
  held: HeldRestoreTarget | HeldRestorePartition,
): RestoreFdQualificationProbe {
  const target = destructiveToolTarget(held);
  return {
    executable: "/usr/bin/stat",
    argv: ["stat", "--format=%t:%T", target],
    inheritedFd: held.fdSlot,
  };
}

function assertSameIdentity(
  actual: RestoreBlockIdentity,
  expected: RestoreBlockIdentity,
  subject: string,
): void {
  if (
    actual.major !== expected.major ||
    actual.minor !== expected.minor ||
    actual.diskseq !== expected.diskseq ||
    actual.sizeBytes !== expected.sizeBytes
  ) {
    throw new Error(`${subject} identity changed; restore is blocked.`);
  }
}

export function retainRestoreTarget(
  openedIdentity: RestoreBlockIdentity,
  authorizedIdentity: RestoreBlockIdentity,
): HeldRestoreTarget {
  assertSameIdentity(openedIdentity, authorizedIdentity, "Whole-device");
  return { fdSlot: 3, identity: { ...openedIdentity } };
}

export function retainRestorePartition(
  target: HeldRestoreTarget,
  openedPartition: RestorePartitionIdentity,
): HeldRestorePartition {
  if (
    openedPartition.partitionNumber !== 1 ||
    openedPartition.parentMajor !== target.identity.major ||
    openedPartition.parentMinor !== target.identity.minor ||
    openedPartition.diskseq !== target.identity.diskseq
  ) {
    throw new Error(
      "New partition is not bound to the retained whole-device identity.",
    );
  }
  return { fdSlot: 4, identity: { ...openedPartition } };
}

export function destructiveToolTarget(
  held: HeldRestoreTarget | HeldRestorePartition,
): `/proc/self/fd/${3 | 4}` {
  return `/proc/self/fd/${held.fdSlot}`;
}
