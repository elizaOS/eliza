import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ComputerUseService } from "../services/computer-use-service.js";

export const MANUAL_DEMO_FINGERPRINT =
  "cerebras-ax-cdp-v1:fixture-only:semantic-ax-and-cdp:no-global-hid:no-private-helper";

export function manualDemoEnabled(): boolean {
  return (
    process.platform === "darwin" &&
    Boolean(process.env.CEREBRAS_API_KEY?.trim()) &&
    process.env.RUN_CEREBRAS_COMPUTER_USE_MANUAL_DEMO === "1" &&
    process.env.CEREBRAS_COMPUTER_USE_MANUAL_DEMO_FINGERPRINT ===
      MANUAL_DEMO_FINGERPRINT &&
    process.env.ELIZA_COMPUTERUSE_EXPERIMENTAL_EXACT_WINDOW !== "1"
  );
}

export async function approveExactManualDemoAction(
  service: ComputerUseService,
  command: string,
  parameters: Record<string, unknown>,
): Promise<{
  request: {
    id: string;
    command: string;
    parameters: Record<string, unknown>;
    requestedAt: string;
  };
  resolution: NonNullable<ReturnType<ComputerUseService["resolveApproval"]>>;
}> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const pending = service
      .getApprovalSnapshot()
      .pendingApprovals.find(
        (request) =>
          request.command === command &&
          JSON.stringify(request.parameters) === JSON.stringify(parameters),
      );
    if (pending) {
      const resolution = service.resolveApproval(
        pending.id,
        true,
        MANUAL_DEMO_FINGERPRINT,
      );
      if (!resolution) {
        throw new Error(`Exact approval ${pending.id} could not be resolved`);
      }
      return { request: pending, resolution };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Exact approval request did not appear for ${command}`);
}

export async function writeManualDemoArtifact(
  relativePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const configuredRoot = process.env.CEREBRAS_COMPUTER_USE_EVIDENCE_DIR?.trim();
  if (!configuredRoot) return;
  const root = resolve(configuredRoot);
  const artifact = resolve(root, relativePath);
  if (!artifact.startsWith(`${root}${sep}`)) {
    throw new Error(
      `Manual-demo artifact escaped evidence root: ${relativePath}`,
    );
  }
  await mkdir(dirname(artifact), { recursive: true });
  await writeFile(artifact, content);
}

export function manualDemoIdentity(model: unknown): Record<string, unknown> {
  return {
    fingerprint: MANUAL_DEMO_FINGERPRINT,
    provider: "cerebras",
    model: typeof model === "string" ? model : "runtime-configured",
    sourceHead: process.env.CEREBRAS_COMPUTER_USE_SOURCE_HEAD ?? "not-provided",
    privateHelperEnabled: false,
    globalHidFallback: false,
  };
}
