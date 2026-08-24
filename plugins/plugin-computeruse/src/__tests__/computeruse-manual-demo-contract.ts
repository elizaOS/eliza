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
): Promise<void> {
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
      service.resolveApproval(pending.id, true, MANUAL_DEMO_FINGERPRINT);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Exact approval request did not appear for ${command}`);
}
