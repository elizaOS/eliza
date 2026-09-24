/** Resolves bootstrap artifact storage before workspace packages can be imported. */
import os from "node:os";
import path from "node:path";

export function resolveSetupStateDir(env = process.env) {
  const explicit = env.ELIZA_STATE_DIR?.trim();
  if (explicit)
    return path.resolve(explicit.replace(/^~(?=$|[\\/])/, os.homedir()));
  const namespace = env.ELIZA_NAMESPACE?.trim() || "eliza";
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg)
    return path.isAbsolute(xdg)
      ? path.join(xdg, namespace)
      : path.join(os.homedir(), xdg, namespace);
  return path.join(os.homedir(), ".local", "state", namespace);
}
