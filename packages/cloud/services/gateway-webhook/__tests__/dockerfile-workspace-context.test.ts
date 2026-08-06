// Guards the invariant that broke this service's deployment silently for three
// months: a service whose package.json declares a `workspace:*` dependency
// cannot be built from a context that contains only its own directory, because
// bun has nothing to resolve the link against. The failure is invisible in
// normal work — tests, typecheck and lint all pass, only `docker build` breaks —
// so it is asserted here rather than left to the next person to rediscover.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SERVICES_DIR = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Services whose Dockerfile still cannot resolve its workspace dependencies.
 * Listed rather than skipped: fixing one makes this list wrong and the test
 * says so, instead of an exemption quietly outliving the defect.
 */
const DOCKERFILE_BROKEN = new Set(["gateway-discord", "agent-server"]);

/** Services still shipping a lockfile written before they gained a workspace dep. */
const LOCKFILE_BLIND = new Set(["gateway-discord"]);

interface ServiceBuild {
  name: string;
  workspaceDeps: string[];
  dockerfile: string;
}

function servicesWithDockerfiles(): ServiceBuild[] {
  const found: ServiceBuild[] = [];
  for (const name of readdirSync(SERVICES_DIR)) {
    const manifestPath = `${SERVICES_DIR}/${name}/package.json`;
    const dockerfilePath = `${SERVICES_DIR}/${name}/Dockerfile`;
    if (!existsSync(manifestPath) || !existsSync(dockerfilePath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const workspaceDeps = Object.entries(manifest.dependencies ?? {})
      .filter(([, range]) => range.startsWith("workspace:"))
      .map(([dep]) => dep);

    found.push({
      name,
      workspaceDeps,
      dockerfile: readFileSync(dockerfilePath, "utf8"),
    });
  }
  return found;
}

/** Maps a package name to the directory it lives in under services/. */
function directoryOf(dependency: string): string | null {
  for (const name of readdirSync(SERVICES_DIR)) {
    const manifestPath = `${SERVICES_DIR}/${name}/package.json`;
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
    };
    if (manifest.name === dependency) return name;
  }
  return null;
}

describe("service Dockerfiles can resolve their workspace dependencies", () => {
  const services = servicesWithDockerfiles();

  test("the scan finds the services it is meant to cover", () => {
    expect(services.map((s) => s.name)).toContain("gateway-webhook");
    expect(
      services.filter((s) => s.workspaceDeps.length > 0).length,
    ).toBeGreaterThan(0);
  });

  for (const service of services.filter((s) => s.workspaceDeps.length > 0)) {
    const shouldPass = !DOCKERFILE_BROKEN.has(service.name);

    test(`${service.name} copies every workspace package it depends on${
      shouldPass ? "" : " (known broken)"
    }`, () => {
      const missing = service.workspaceDeps.filter((dependency) => {
        const directory = directoryOf(dependency);
        // A dependency outside services/ is not something this Dockerfile can
        // vendor by directory copy; treat it as missing so the case surfaces.
        if (!directory) return true;
        return !service.dockerfile.includes(directory);
      });

      if (shouldPass) {
        expect(missing).toEqual([]);
      } else {
        // Pinned so that fixing the service fails here and the entry must be
        // removed from KNOWN_BROKEN, rather than the exemption outliving it.
        expect(missing.length).toBeGreaterThan(0);
      }
    });
  }

  test("this service builds from the repository root, and says so", () => {
    const gateway = services.find((s) => s.name === "gateway-webhook");
    expect(gateway?.workspaceDeps).toContain("@elizaos/cloud-services-common");
    // The path prefix is what proves the context: a repo-root build addresses
    // its own files through the full path, a directory-scoped one does not.
    expect(gateway?.dockerfile).toContain(
      "packages/cloud/services/gateway-webhook",
    );
    expect(gateway?.dockerfile).toContain("packages/cloud/services/_common");
  });

  for (const service of services.filter((s) => s.workspaceDeps.length > 0)) {
    const shouldPass = !LOCKFILE_BLIND.has(service.name);

    test(`${service.name} does not ship a lockfile blind to its workspace deps${
      shouldPass ? "" : " (known broken)"
    }`, () => {
      // The stale service-local bun.lock is what hid the build failure:
      // `--frozen-lockfile` read a lockfile written before the workspace
      // dependency existed, so it could never have installed it. Services
      // without workspace deps may legitimately keep their own lockfile.
      // No service-local lockfile is the healthy shape: the root one is
      // authoritative for a workspace member.
      const lockPath = `${SERVICES_DIR}/${service.name}/bun.lock`;
      if (!existsSync(lockPath)) {
        expect(LOCKFILE_BLIND.has(service.name)).toBe(false);
        return;
      }

      const lock = readFileSync(lockPath, "utf8");
      const blind = service.workspaceDeps.filter((dep) => !lock.includes(dep));
      if (shouldPass) {
        expect(blind).toEqual([]);
      } else {
        expect(blind.length).toBeGreaterThan(0);
      }
    });
  }
});
