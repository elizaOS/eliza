/** Claims a real pending host request; only renderer transport is simulated. */
import type { IAgentRuntime } from "@elizaos/core";
import { viewInteractionHost } from "../api/view-interaction-host.ts";

export function claimRendererReply(
  runtime: IAgentRuntime,
  hostKey: object,
  clientId: string,
  frame: Record<string, unknown>,
) {
  const { requestId, viewId, viewType, installationId } = frame;
  if (
    [requestId, viewId, viewType, installationId].some(
      (part) => typeof part !== "string",
    )
  )
    throw new Error(
      "Renderer fixture received an incomplete installation binding",
    );
  const binding = {
    requestId: requestId as string,
    viewId: viewId as string,
    viewType: viewType as string,
    installationId: installationId as string,
  };
  const claimId = viewInteractionHost(runtime, hostKey).claim(
    clientId,
    binding,
    [],
  );
  if (!claimId)
    throw new Error("Renderer fixture could not claim this request");
  return { ...binding, claimId };
}
