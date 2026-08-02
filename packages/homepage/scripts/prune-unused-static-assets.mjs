/**
 * Removes optional artifact-bundle graphics that the homepage does not reference.
 *
 * Some developer checkouts hydrate shared videos and OS product concepts into
 * public/. Vite copies that entire directory, so pruning the exact unused
 * output directories keeps Cloudflare uploads independent of checkout state.
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const distRoot = resolve(import.meta.dirname, "../dist");

for (const relativePath of ["brand/background", "product"]) {
  rmSync(resolve(distRoot, relativePath), { recursive: true, force: true });
}
