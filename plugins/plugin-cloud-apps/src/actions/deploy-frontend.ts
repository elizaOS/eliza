/**
 * DEPLOY_FRONTEND — "host / publish the frontend for app X".
 *
 * Publishes a static site to an app's managed frontend host: reads a built site
 * directory (the `dist`/`build` output the agent produced) — or an inline
 * `files` array — packages the files (text as utf8, binary as base64), and
 * POSTs them to `/api/v1/apps/:id/frontend` via the SDK. The server
 * content-addresses the files to R2, finalizes a manifest, and activates the
 * deployment, which is then served with SEO + page analytics at the app's
 * frontend host / custom domain.
 *
 * This is the seam that lets an agent ship a FULL app on Cloud (frontend +
 * optional backend container) instead of pointing at an external URL.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DeployAppFrontendInput,
  FrontendUploadFileInput,
} from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  extractAppReference,
  getCloudClient,
  resolveApp,
  resolveCloudApiKey,
} from "../client.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can host your app's frontend.";
const NO_REFERENCE_MESSAGE =
  "Which app's frontend should I publish? Tell me the app name and the built-site directory.";
const NO_SOURCE_MESSAGE =
  "I need the built site to publish — give me the directory of your build output (e.g. ./dist) or the files.";
const OUTSIDE_ROOT_MESSAGE =
  "I can only publish build output from the configured frontend build root.";
const ERROR_MESSAGE =
  "I couldn't publish that frontend right now — the Cloud API returned an error. Try again in a moment.";

// Caps mirror the server (`app-frontend-hosting.ts`): reject before upload.
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", ".turbo", ".cache"]);
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db"]);
const TEXT_EXTS = new Set([
  "html",
  "htm",
  "js",
  "mjs",
  "css",
  "json",
  "webmanifest",
  "map",
  "txt",
  "xml",
  "svg",
]);

interface FrontendIntent {
  directory: string | null;
  files: FrontendUploadFileInput[] | null;
  entrypoint?: string;
  spaFallback?: boolean;
}

const DIRECTORY_KEYS = [
  "directory",
  "dir",
  "path",
  "buildDir",
  "build_dir",
  "source",
];
const FRONTEND_BUILD_ROOT_SETTING = "ELIZAOS_CLOUD_FRONTEND_BUILD_ROOT";

function readOptionRecord(options: unknown): Record<string, unknown> | null {
  if (!options || typeof options !== "object") return null;
  const opts = options as Record<string, unknown>;
  // Validated planner params arrive nested under `parameters`; fall back to top-level.
  const nested = opts.parameters;
  if (nested && typeof nested === "object")
    return nested as Record<string, unknown>;
  return opts;
}

function parseIntent(options: unknown): FrontendIntent {
  const rec = readOptionRecord(options);
  const intent: FrontendIntent = { directory: null, files: null };
  if (!rec) return intent;
  for (const key of DIRECTORY_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v.trim().length > 0) {
      intent.directory = v.trim();
      break;
    }
  }
  if (Array.isArray(rec.files)) {
    intent.files = rec.files as FrontendUploadFileInput[];
  }
  if (typeof rec.entrypoint === "string") intent.entrypoint = rec.entrypoint;
  if (typeof rec.spaFallback === "boolean")
    intent.spaFallback = rec.spaFallback;
  return intent;
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function resolveFrontendBuildRoot(
  runtime: IAgentRuntime,
): Promise<string> {
  const configured = runtime.getSetting?.(FRONTEND_BUILD_ROOT_SETTING);
  const root =
    typeof configured === "string" && configured.trim().length > 0
      ? configured.trim()
      : process.cwd();
  const absRoot = path.isAbsolute(root)
    ? path.resolve(root)
    : path.resolve(process.cwd(), root);
  return fs.realpath(absRoot);
}

async function resolveBuildDirectory(
  runtime: IAgentRuntime,
  requestedDirectory: string,
): Promise<string> {
  const root = await resolveFrontendBuildRoot(runtime);
  const requested = path.isAbsolute(requestedDirectory)
    ? path.resolve(requestedDirectory)
    : path.resolve(root, requestedDirectory);
  const realRequested = await fs.realpath(requested);
  if (!isInsideRoot(root, realRequested)) {
    throw new Error(OUTSIDE_ROOT_MESSAGE);
  }
  return realRequested;
}

/** Walk a build directory into upload files (text as utf8, binary as base64). */
async function readDirectoryAsFiles(
  root: string,
): Promise<FrontendUploadFileInput[]> {
  const files: FrontendUploadFileInput[] = [];
  let totalBytes = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (
        !entry.isFile() ||
        SKIP_FILES.has(entry.name) ||
        entry.name.startsWith(".")
      )
        continue;

      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      const bytes = await fs.readFile(abs);
      totalBytes += bytes.byteLength;
      if (files.length + 1 > MAX_FILES) {
        throw new Error(
          `Too many files (> ${MAX_FILES}). Trim the build output.`,
        );
      }
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(
          `Build exceeds the ${MAX_TOTAL_BYTES / (1024 * 1024)}MB frontend cap.`,
        );
      }
      const ext = rel.split(".").pop()?.toLowerCase() ?? "";
      if (TEXT_EXTS.has(ext)) {
        files.push({
          path: rel,
          content: bytes.toString("utf8"),
          encoding: "utf8",
        });
      } else {
        files.push({
          path: rel,
          content: bytes.toString("base64"),
          encoding: "base64",
        });
      }
    }
  }

  await walk(root);
  return files;
}

export const deployFrontendAction: Action = {
  name: "DEPLOY_FRONTEND",
  similes: [
    "HOST_FRONTEND",
    "PUBLISH_SITE",
    "PUBLISH_FRONTEND",
    "DEPLOY_SITE",
    "HOST_SITE",
  ],
  description:
    "Publish a static frontend (built site directory or files) to an Eliza Cloud app's managed host, served with SEO + analytics. Use when the user asks to host, publish, or deploy the app's website/frontend.",
  descriptionCompressed:
    "Publish an app's static frontend to Eliza Cloud managed hosting.",
  contexts: ["settings", "apps"],
  contextGate: { anyOf: ["settings", "apps"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return resolveCloudApiKey(runtime) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["DEPLOY_FRONTEND"] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const reference = extractAppReference(message, options);
    if (!reference) {
      await callback?.({
        text: NO_REFERENCE_MESSAGE,
        actions: ["DEPLOY_FRONTEND"],
      });
      return {
        success: false,
        text: "No app reference supplied.",
        userFacingText: NO_REFERENCE_MESSAGE,
        data: { reason: "no_reference" },
      };
    }

    const { app, available } = await resolveApp(client, reference);
    if (!app) {
      const msg =
        available.length === 0
          ? "You don't have any apps on Eliza Cloud yet — ask me to create one first."
          : `I couldn't find an app matching "${reference}". Your apps are: ${available.join(", ")}.`;
      await callback?.({ text: msg, actions: ["DEPLOY_FRONTEND"] });
      return {
        success: false,
        text: "App not found.",
        userFacingText: msg,
        data: { reason: "not_found" },
      };
    }

    const intent = parseIntent(options);
    let files: FrontendUploadFileInput[];
    try {
      if (intent.files && intent.files.length > 0) {
        files = intent.files;
      } else if (intent.directory) {
        files = await readDirectoryAsFiles(
          await resolveBuildDirectory(runtime, intent.directory),
        );
      } else {
        await callback?.({
          text: NO_SOURCE_MESSAGE,
          actions: ["DEPLOY_FRONTEND"],
        });
        return {
          success: false,
          text: "No build directory or files provided.",
          userFacingText: NO_SOURCE_MESSAGE,
          data: { reason: "no_source" },
        };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await callback?.({
        text: `I couldn't read the build: ${detail}`,
        actions: ["DEPLOY_FRONTEND"],
      });
      return {
        success: false,
        text: "Failed to read build output.",
        userFacingText: `I couldn't read the build: ${detail}`,
        error: err instanceof Error ? err : new Error(detail),
        data: { reason: "read_failed" },
      };
    }

    if (files.length === 0) {
      await callback?.({
        text: NO_SOURCE_MESSAGE,
        actions: ["DEPLOY_FRONTEND"],
      });
      return {
        success: false,
        text: "No files to publish.",
        userFacingText: NO_SOURCE_MESSAGE,
        data: { reason: "empty" },
      };
    }

    try {
      const body: DeployAppFrontendInput = {
        files,
        entrypoint: intent.entrypoint,
        spaFallback: intent.spaFallback,
        buildMeta: { source: "agent" },
      };
      const { deployment } = await client.deployAppFrontend(app.id, body);

      // Don't claim "live" unless the deployment actually activated. The
      // publish can succeed into a "ready" (built, not serving) state where
      // activation failed or is pending — reporting that as live is a lie the
      // user acts on. Only status === "active" is truthfully live.
      const size = `${deployment.file_count} files, ${(deployment.total_bytes / 1024).toFixed(0)} KB`;
      const isLive = deployment.status === "active";
      const reply = isLive
        ? [
            `Published "${app.name}" frontend — v${deployment.version} is now live (${size}).`,
            `Preview it under your app's frontend host. Attach a custom domain to serve it publicly.`,
          ].join("\n")
        : [
            `Published "${app.name}" frontend v${deployment.version} (${size}) — it's built but NOT yet live (status: ${deployment.status}).`,
            `Activation hasn't completed; try again shortly, or check the app's frontend deployments if it stays this way.`,
          ].join("\n");

      await callback?.({ text: reply, actions: ["DEPLOY_FRONTEND"] });
      return {
        success: true,
        text: `Published frontend v${deployment.version} for ${app.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          app: { id: app.id, name: app.name },
          deployment: {
            id: deployment.id,
            version: deployment.version,
            status: deployment.status,
            files: deployment.file_count,
            bytes: deployment.total_bytes,
          },
        },
      };
    } catch (err) {
      logger.warn(
        `[DEPLOY_FRONTEND] Failed to publish frontend for "${app.name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["DEPLOY_FRONTEND"] });
      return {
        success: false,
        text: "Failed to publish frontend.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "publish the frontend for Acme Bot from ./dist" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Published "Acme Bot" frontend — v1 is now live (12 files, 340 KB).\nPreview it under your app\'s frontend host. Attach a custom domain to serve it publicly.',
          actions: ["DEPLOY_FRONTEND"],
        },
      },
    ],
  ],
};

export default deployFrontendAction;
