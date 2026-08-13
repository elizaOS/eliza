/**
 * Inventories every persisted and operator-configured app image before the
 * node deploy backend is armed, preventing legacy mutable tags from reaching a
 * deployment job after immutable enforcement becomes mandatory.
 */

import { ElizaError } from "@elizaos/core";
import { appsRepository } from "../../db/repositories/apps";
import { parsePrebuiltImageMap } from "./app-image-resolver";
import { describeImageReference } from "./containers/image-rollout-status";

interface PreflightApp {
  id: string;
  name: string;
  metadata: unknown;
}

export interface AppsDeployImagePreflightOptions {
  env?: NodeJS.ProcessEnv;
  listApps?: () => Promise<PreflightApp[]>;
}

function immutable(reference: string): boolean {
  return describeImageReference(reference).productionSafe;
}

/** Fail before backend registration when any app deploy source is not immutable. */
export async function assertAppsDeployImagesImmutable(
  options: AppsDeployImagePreflightOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const violations: string[] = [];

  for (const variable of ["APP_DEFAULT_IMAGE", "APP_DEFAULT_TEMPLATE_IMAGE"] as const) {
    const reference = env[variable];
    if (reference !== undefined && !immutable(reference)) {
      violations.push(`${variable}=${JSON.stringify(reference)}`);
    }
  }

  const rawMap = env.APP_PREBUILT_IMAGES;
  if (rawMap?.trim()) {
    try {
      for (const [prefix, reference] of parsePrebuiltImageMap(rawMap)) {
        if (!immutable(reference)) {
          violations.push(
            `APP_PREBUILT_IMAGES[${JSON.stringify(prefix)}]=${JSON.stringify(reference)}`,
          );
        }
      }
    } catch (error) {
      // error-policy:J3 retain the explicit configuration failure in the
      // aggregated startup inventory rather than treating the map as absent.
      violations.push(error instanceof Error ? error.message : String(error));
    }
  }

  const apps = await (options.listApps ?? (() => appsRepository.listAll()))();
  for (const app of apps) {
    if (!app.metadata || typeof app.metadata !== "object" || Array.isArray(app.metadata)) continue;
    const metadata = app.metadata as Record<string, unknown>;
    if (!Object.hasOwn(metadata, "imageTag")) continue;
    const reference = metadata.imageTag;
    if (typeof reference !== "string" || !immutable(reference)) {
      violations.push(
        `app ${app.id} (${JSON.stringify(app.name)}) metadata.imageTag=${JSON.stringify(reference)}`,
      );
    }
  }

  if (violations.length > 0) {
    throw new ElizaError(
      `Apps deploy image preflight failed; repin every image to repo@sha256:<64 hex>:\n- ${violations.join("\n- ")}`,
      {
        code: "APPS_DEPLOY_IMAGE_PREFLIGHT_FAILED",
        context: { violations },
        severity: "fatal",
      },
    );
  }
}
