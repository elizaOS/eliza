import { createHash } from "node:crypto";

export const LINUX_RESTORE_HELPER_REQUEST_MAX_BYTES = 2048;
export const LINUX_RESTORE_HELPER_RESPONSE_MAX_BYTES = 1024;

const REQUEST_MAGIC = "ELIZAOS_USB_RESTORE_REQUEST_V1";
const RESPONSE_MAGIC = "ELIZAOS_USB_RESTORE_RESULT_V1";
const PLAN_ID_PATTERN = /^[a-f0-9]{32}$/;
const BOOT_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
// The native request field is 128 bytes including its NUL terminator, so the
// complete ASCII path may be at most 127 bytes (`/dev/` plus 122 bytes).
const DEVICE_PATH_PATTERN = /^\/dev\/[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/;
const RESPONSE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface LinuxRestoreHelperPlan {
  planId: string;
  bootId: string;
  devicePath: string;
  expectedMajor: string;
  expectedMinor: string;
  expectedDiskseq: string;
  expectedSizeBytes: string;
  partitionNumber: "1";
  filesystem: "exfat";
  label: "ELIZAOS-USB";
  acknowledgement: "ERASE";
}

export interface LinuxRestoreHelperResponse {
  status: "blocked" | "error" | "ok";
  code: string;
  message: string;
}

function assertAsciiField(name: string, value: string): void {
  if (!/^[\x20-\x7e]+$/.test(value)) {
    throw new Error(`${name} must contain printable ASCII only.`);
  }
}

function assertUnsignedDecimal(
  name: string,
  value: string,
  options: { allowZero?: boolean } = {},
): void {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error(`${name} must be a canonical unsigned decimal integer.`);
  }
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) {
    throw new Error(`${name} exceeds uint64.`);
  }
  if (!options.allowZero && parsed === 0n) {
    throw new Error(`${name} must be greater than zero.`);
  }
}

export function assertLinuxRestoreHelperPlan(
  plan: unknown,
): asserts plan is LinuxRestoreHelperPlan {
  const exactKeys = [
    "acknowledgement",
    "bootId",
    "devicePath",
    "expectedDiskseq",
    "expectedMajor",
    "expectedMinor",
    "expectedSizeBytes",
    "filesystem",
    "label",
    "partitionNumber",
    "planId",
  ];
  if (
    typeof plan !== "object" ||
    plan === null ||
    Array.isArray(plan) ||
    Object.keys(plan).sort().join("\n") !== exactKeys.join("\n")
  ) {
    throw new Error("Linux Restore helper plan has missing or unknown fields.");
  }
  const candidate = plan as Record<string, unknown>;
  if (Object.values(candidate).some((value) => typeof value !== "string")) {
    throw new Error("Linux Restore helper plan fields must all be strings.");
  }
  const typedPlan = candidate as unknown as LinuxRestoreHelperPlan;
  if (!PLAN_ID_PATTERN.test(typedPlan.planId)) {
    throw new Error(
      "planId must be exactly 128 bits of lowercase hexadecimal.",
    );
  }
  if (!BOOT_ID_PATTERN.test(typedPlan.bootId)) {
    throw new Error("bootId must be one canonical lowercase kernel boot ID.");
  }
  if (
    !DEVICE_PATH_PATTERN.test(typedPlan.devicePath) ||
    typedPlan.devicePath.includes("..")
  ) {
    throw new Error("devicePath must be one direct /dev device-node name.");
  }
  assertUnsignedDecimal("expectedMajor", typedPlan.expectedMajor, {
    allowZero: true,
  });
  assertUnsignedDecimal("expectedMinor", typedPlan.expectedMinor, {
    allowZero: true,
  });
  if (
    BigInt(typedPlan.expectedMajor) > 4_294_967_295n ||
    BigInt(typedPlan.expectedMinor) > 4_294_967_295n
  ) {
    throw new Error(
      "expectedMajor and expectedMinor must fit Linux dev_t fields.",
    );
  }
  assertUnsignedDecimal("expectedDiskseq", typedPlan.expectedDiskseq);
  assertUnsignedDecimal("expectedSizeBytes", typedPlan.expectedSizeBytes);
  if (
    typedPlan.partitionNumber !== "1" ||
    typedPlan.filesystem !== "exfat" ||
    typedPlan.label !== "ELIZAOS-USB" ||
    typedPlan.acknowledgement !== "ERASE"
  ) {
    throw new Error(
      "Linux Restore supports only the fixed GPT, one-partition, exFAT layout.",
    );
  }
}

export function canonicalLinuxRestorePlan(
  plan: LinuxRestoreHelperPlan,
): string {
  assertLinuxRestoreHelperPlan(plan);
  return [
    REQUEST_MAGIC,
    "operation=restore",
    `plan_id=${plan.planId}`,
    `boot_id=${plan.bootId}`,
    `device_path=${plan.devicePath}`,
    `expected_major=${plan.expectedMajor}`,
    `expected_minor=${plan.expectedMinor}`,
    `expected_diskseq=${plan.expectedDiskseq}`,
    `expected_size_bytes=${plan.expectedSizeBytes}`,
    `partition_number=${plan.partitionNumber}`,
    `filesystem=${plan.filesystem}`,
    `label=${plan.label}`,
    `acknowledgement=${plan.acknowledgement}`,
    "END",
    "",
  ].join("\n");
}

export function encodeLinuxRestoreHelperRequest(
  plan: LinuxRestoreHelperPlan,
): Uint8Array {
  const canonicalPlan = canonicalLinuxRestorePlan(plan);
  const binding = createHash("sha256").update(canonicalPlan).digest("hex");
  const lines = canonicalPlan.split("\n");
  lines.splice(3, 0, `plan_binding=${binding}`);
  const encoded = Buffer.from(lines.join("\n"), "ascii");
  if (encoded.byteLength > LINUX_RESTORE_HELPER_REQUEST_MAX_BYTES) {
    throw new Error("Linux Restore helper request exceeds its byte limit.");
  }
  return encoded;
}

export function parseLinuxRestoreHelperResponse(
  value: Uint8Array,
): LinuxRestoreHelperResponse {
  if (
    value.byteLength === 0 ||
    value.byteLength > LINUX_RESTORE_HELPER_RESPONSE_MAX_BYTES
  ) {
    throw new Error(
      "Linux Restore helper response has an invalid byte length.",
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(
      "Linux Restore helper response is not valid bounded UTF-8.",
    );
  }
  if (text.includes("\0")) {
    throw new Error(
      "Linux Restore helper response is not valid bounded UTF-8.",
    );
  }
  const lines = text.split("\n");
  if (
    lines.length !== 6 ||
    lines[0] !== RESPONSE_MAGIC ||
    lines[4] !== "END" ||
    lines[5] !== ""
  ) {
    throw new Error("Linux Restore helper response framing is invalid.");
  }
  const status = lines[1]?.slice("status=".length);
  const code = lines[2]?.slice("code=".length);
  const message = lines[3]?.slice("message=".length);
  if (
    !lines[1]?.startsWith("status=") ||
    !lines[2]?.startsWith("code=") ||
    !lines[3]?.startsWith("message=") ||
    (status !== "blocked" && status !== "error" && status !== "ok") ||
    !code ||
    !RESPONSE_CODE_PATTERN.test(code) ||
    !message ||
    message.length > 256
  ) {
    throw new Error("Linux Restore helper response fields are invalid.");
  }
  assertAsciiField("message", message);
  return { status, code, message };
}
