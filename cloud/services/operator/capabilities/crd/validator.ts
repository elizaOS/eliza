import { PeprValidateRequest } from "pepr";
import { Server } from "./generated/server-v1alpha1";

export async function validator(req: PeprValidateRequest<Server>) {
  const spec = req.Raw.spec;

  if (!spec) {
    return req.Deny("spec is required");
  }

  if (spec.capacity < 1 || spec.capacity > 200) {
    return req.Deny("capacity must be between 1 and 200");
  }

  const agents = spec.agents ?? [];

  if (agents.length > spec.capacity) {
    return req.Deny(`agents count (${agents.length}) exceeds capacity (${spec.capacity})`);
  }

  if (agents.length > 0) {
    const agentIds = agents.map((a) => a.agentId);
    const uniqueIds = new Set(agentIds);
    if (uniqueIds.size !== agentIds.length) {
      return req.Deny("duplicate agentId in spec.agents");
    }
  }

  return req.Approve();
}
