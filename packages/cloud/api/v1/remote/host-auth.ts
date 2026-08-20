/** Host-only bearer authentication for relay polling/completion. */
import type { Context } from "hono";
import { remoteHostsRepository } from "@/db/repositories/remote-hosts";
import type { AppEnv } from "@/types/cloud-worker-env";

export async function authenticateRemoteHost(c: Context<AppEnv>) {
  const hostId = c.req.header("X-Eliza-Remote-Host-Id")?.trim() ?? "";
  const token = c.req.header("X-Eliza-Remote-Host-Token")?.trim() ?? "";
  if (!hostId || !token) return undefined;
  return remoteHostsRepository.authenticate(hostId, token);
}
