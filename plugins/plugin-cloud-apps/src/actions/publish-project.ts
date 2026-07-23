/**
 * Publishes one local Project through its durable Cloud app binding.
 *
 * Creation binds immediately, before deployment, so retries reuse one Cloud
 * identity. The Cloud row stays inactive until managed hosting activates and
 * answers, or the existing container deploy gate proves READY + reachable.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AppDto,
  DeployAppInput,
  FrontendUploadFileInput,
} from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  ProjectRecord,
  State,
} from "@elizaos/core";
import {
  bindProjectCloudApp,
  ElizaError,
  logger,
  unbindProjectCloudApp,
} from "@elizaos/core";
import { recordAppDeployFact } from "../app-facts.js";
import { getCloudClient, resolveCloudApiKey } from "../client.js";
import { DEFAULT_DEPLOY_GATE_CONFIG, runDeployGate } from "../deploy-gate.js";
import {
  projectOptionSources,
  projectResolutionMessage,
  resolveProject,
} from "../project-resolution.js";
import { invalidateAppsCache } from "../providers/cloud-apps.js";
import {
  probeReachable,
  respondedManagedFrontendLive,
} from "../reachability.js";
import { readDirectoryAsFiles } from "./deploy-frontend.js";

const ACTION = "PUBLISH_PROJECT";
const PENDING_URL = "https://pending.invalid";
const BUILD_DIR_CANDIDATES = ["dist", "build", "out", "public"] as const;
const NO_KEY_MESSAGE = "Connect Eliza Cloud before publishing a project.";
const ERROR_MESSAGE =
  "I couldn't finish publishing that project. Its Cloud record remains bound so a retry will reuse the same identity; check its current Cloud state in the Publish panel.";

type PublishMode = "managed-frontend" | "container";

interface PublishIntent {
  mode: PublishMode;
  name?: string;
  description?: string;
  directory?: string;
  files?: FrontendUploadFileInput[];
  entrypoint?: string;
  spaFallback?: boolean;
  ref?: string;
  dockerfile?: string;
}

function stringOption(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parseFrontendFiles(value: unknown): FrontendUploadFileInput[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) return null;
  const files: FrontendUploadFileInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.path !== "string" ||
      !record.path.trim() ||
      typeof record.content !== "string" ||
      (record.encoding !== undefined &&
        record.encoding !== "utf8" &&
        record.encoding !== "base64") ||
      (record.contentType !== undefined &&
        typeof record.contentType !== "string")
    ) {
      return null;
    }
    files.push({
      path: record.path,
      content: record.content,
      ...(record.encoding ? { encoding: record.encoding } : {}),
      ...(record.contentType ? { contentType: record.contentType } : {}),
    });
  }
  return files;
}

function parseIntent(
  options: unknown,
): { ok: true; value: PublishIntent } | { ok: false; message: string } {
  const source = projectOptionSources(options)[0] ?? {};
  const rawMode = stringOption(source, "mode", "hosting", "publishMode");
  const mode: PublishMode =
    rawMode === undefined ||
    rawMode === "managed-frontend" ||
    rawMode === "frontend" ||
    rawMode === "static"
      ? "managed-frontend"
      : rawMode === "container"
        ? "container"
        : "managed-frontend";
  if (
    rawMode !== undefined &&
    !["managed-frontend", "frontend", "static", "container"].includes(rawMode)
  ) {
    return {
      ok: false,
      message: "Publish mode must be managed-frontend or container.",
    };
  }
  const parsedFiles = parseFrontendFiles(source.files);
  if (source.files !== undefined && parsedFiles === null) {
    return {
      ok: false,
      message:
        "Frontend files must be a non-empty array of {path, content, encoding?}.",
    };
  }
  const spaFallback = source.spaFallback ?? source.spa_fallback;
  if (spaFallback !== undefined && typeof spaFallback !== "boolean") {
    return {
      ok: false,
      message: "spaFallback must be true or false.",
    };
  }
  return {
    ok: true,
    value: {
      mode,
      ...(stringOption(source, "name", "title")
        ? { name: stringOption(source, "name", "title") }
        : {}),
      ...(stringOption(source, "description")
        ? { description: stringOption(source, "description") }
        : {}),
      ...(stringOption(source, "directory", "buildDir", "build_dir")
        ? {
            directory: stringOption(
              source,
              "directory",
              "buildDir",
              "build_dir",
            ),
          }
        : {}),
      ...(parsedFiles ? { files: parsedFiles } : {}),
      ...(stringOption(source, "entrypoint")
        ? { entrypoint: stringOption(source, "entrypoint") }
        : {}),
      ...(typeof spaFallback === "boolean" ? { spaFallback } : {}),
      ...(stringOption(source, "ref", "commit", "commitSha")
        ? { ref: stringOption(source, "ref", "commit", "commitSha") }
        : {}),
      ...(stringOption(source, "dockerfile")
        ? { dockerfile: stringOption(source, "dockerfile") }
        : {}),
    },
  };
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function hasIndexHtml(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(directory, "index.html"))).isFile();
  } catch {
    // error-policy:J4 a missing candidate is expected during build-output discovery.
    return false;
  }
}

async function resolveBuildDirectory(
  project: ProjectRecord,
  requested?: string,
): Promise<string> {
  const projectRoot = await fs.realpath(project.localPath);
  if (requested) {
    const target = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(projectRoot, requested);
    const realTarget = await fs.realpath(target);
    if (!isInside(projectRoot, realTarget)) {
      throw new ElizaError(
        "Frontend build directory must stay inside the project",
        {
          code: "PROJECT_BUILD_OUTSIDE_ROOT",
          context: { projectId: project.id, requested },
          severity: "fatal",
        },
      );
    }
    return realTarget;
  }

  for (const candidate of BUILD_DIR_CANDIDATES) {
    const directory = path.join(projectRoot, candidate);
    if (await hasIndexHtml(directory)) return directory;
  }
  throw new ElizaError(
    "No built frontend was found; build the project or provide its output directory",
    {
      code: "PROJECT_BUILD_NOT_FOUND",
      context: {
        projectId: project.id,
        candidates: BUILD_DIR_CANDIDATES,
      },
      severity: "ephemeral",
    },
  );
}

function cloudStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as Record<string, unknown>).statusCode;
  return typeof status === "number" ? status : null;
}

async function readBoundApp(
  project: ProjectRecord,
  client: NonNullable<ReturnType<typeof getCloudClient>>,
): Promise<{ project: ProjectRecord; app: AppDto | null }> {
  if (!project.cloudAppId) return { project, app: null };
  try {
    const response = await client.getApp(project.cloudAppId);
    return { project, app: response.app };
  } catch (err) {
    if (cloudStatusCode(err) !== 404) throw err;
    const unbound = unbindProjectCloudApp(project.id);
    if (!unbound) {
      throw new ElizaError("Project disappeared while clearing stale binding", {
        code: "PROJECT_NOT_FOUND",
        context: { projectId: project.id },
        cause: err,
        severity: "fatal",
      });
    }
    return { project: unbound, app: null };
  }
}

export const publishProjectAction: Action = {
  name: ACTION,
  similes: [
    "PUBLISH_MY_PROJECT",
    "DEPLOY_PROJECT",
    "SHIP_PROJECT",
    "MAKE_PROJECT_LIVE",
  ],
  description:
    "Publish a local project to Eliza Cloud. Managed frontend hosting is the default and auto-detects dist/build/out output; container publication requires a repository and immutable commit SHA. Reuses the project's existing Cloud binding.",
  descriptionCompressed:
    "Publish the active project to Cloud and verify it is live.",
  contexts: ["apps", "projects", "settings", "code"],
  contextGate: { anyOf: ["apps", "projects", "settings", "code"] },
  roleGate: { minRole: "ADMIN" },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "project",
      description:
        "Optional project name or id. Omit to use the active project.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "mode",
      description:
        "managed-frontend (default) or container. Container deploy may be organization-gated.",
      required: false,
      schema: {
        type: "string",
        enum: ["managed-frontend", "container"],
      },
    },
    {
      name: "directory",
      description:
        "Optional built frontend directory inside the project. Omit to auto-detect dist/build/out/public.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "ref",
      description:
        "Immutable 40- or 64-character commit SHA required for container publication.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: [ACTION] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }
    const intent = parseIntent(options);
    if (!intent.ok) {
      await callback?.({ text: intent.message, actions: [ACTION] });
      return {
        success: false,
        text: "Invalid publish input.",
        userFacingText: intent.message,
        data: { reason: "invalid_input" },
      };
    }

    let projectForFailure: ProjectRecord | null = null;
    try {
      const resolution = resolveProject(message, options);
      if (!resolution.project) {
        const reply = projectResolutionMessage(resolution);
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: false,
          text: "Project could not be resolved.",
          userFacingText: reply,
          data: { reason: resolution.reason },
        };
      }
      projectForFailure = resolution.project;
      if (intent.value.mode === "container") {
        if (!resolution.project.repoUrl) {
          const reply = `"${resolution.project.name}" needs a registered Git repository before container publication. Managed frontend hosting is available now.`;
          await callback?.({ text: reply, actions: [ACTION] });
          return {
            success: false,
            text: "Project has no repository for container deploy.",
            userFacingText: reply,
            verifiedUserFacing: true,
            data: {
              reason: "missing_repo",
              projectId: resolution.project.id,
              cloudAppId: resolution.project.cloudAppId,
            },
          };
        }
        if (
          !intent.value.ref ||
          !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(intent.value.ref)
        ) {
          const reply =
            "Container publication requires an immutable 40- or 64-character commit SHA.";
          await callback?.({ text: reply, actions: [ACTION] });
          return {
            success: false,
            text: "Container deploy ref is not an immutable commit SHA.",
            userFacingText: reply,
            data: {
              reason: "invalid_commit",
              projectId: resolution.project.id,
              cloudAppId: resolution.project.cloudAppId,
            },
          };
        }
      }
      const existing = await readBoundApp(resolution.project, client);
      let project = existing.project;
      let app = existing.app;
      let createdCloudRecord = false;
      const publishName = intent.value.name ?? project.name;
      const publishDescription = intent.value.description ?? "";

      if (!app) {
        const created = await client.createApp({
          name: publishName,
          ...(publishDescription ? { description: publishDescription } : {}),
          app_url: PENDING_URL,
          allowed_origins: [PENDING_URL],
          is_active: false,
          skipGitHubRepo: true,
        });
        app = created.app;
        const bound = bindProjectCloudApp(project.id, app.id);
        if (!bound) {
          throw new ElizaError(
            "Project disappeared before its Cloud binding could be persisted",
            {
              code: "PROJECT_BIND_FAILED",
              context: { projectId: project.id, cloudAppId: app.id },
              severity: "fatal",
            },
          );
        }
        project = bound;
        projectForFailure = bound;
        createdCloudRecord = true;
      }

      await client.updateApp(app.id, { is_active: false });
      let publicUrl: string;
      let hosting: PublishMode;
      let publishedApp: AppDto | null = null;

      if (intent.value.mode === "managed-frontend") {
        const files =
          intent.value.files ??
          (await readDirectoryAsFiles(
            await resolveBuildDirectory(project, intent.value.directory),
          ));
        if (files.length === 0) {
          throw new ElizaError("Built frontend contains no publishable files", {
            code: "PROJECT_BUILD_EMPTY",
            context: { projectId: project.id },
            severity: "ephemeral",
          });
        }
        const published = await client.deployAppFrontend(app.id, {
          files,
          ...(intent.value.entrypoint
            ? { entrypoint: intent.value.entrypoint }
            : {}),
          ...(intent.value.spaFallback !== undefined
            ? { spaFallback: intent.value.spaFallback }
            : {}),
          activate: true,
          buildMeta: { source: "project-publish" },
        });
        if (
          published.deployment.status !== "active" ||
          !published.public_url?.trim()
        ) {
          throw new ElizaError(
            "Managed frontend did not activate with an authoritative public URL",
            {
              code: "PROJECT_FRONTEND_NOT_LIVE",
              context: {
                projectId: project.id,
                deploymentId: published.deployment.id,
                status: published.deployment.status,
              },
              severity: "ephemeral",
            },
          );
        }
        publicUrl = published.public_url.trim();
        const activated = await client.updateApp(app.id, {
          name: publishName,
          description: publishDescription,
          app_url: publicUrl,
          allowed_origins: [publicUrl],
          is_active: true,
        });
        try {
          const reachability = await probeReachable(publicUrl);
          if (!respondedManagedFrontendLive(reachability)) {
            throw new ElizaError(
              "Managed frontend did not return public content from its live URL",
              {
                code: "PROJECT_FRONTEND_UNREACHABLE",
                context: {
                  projectId: project.id,
                  publicUrl,
                  reachability,
                },
                severity: "ephemeral",
              },
            );
          }
        } catch (probeError) {
          try {
            await client.updateApp(app.id, { is_active: false });
          } catch (rollbackError) {
            throw new ElizaError(
              "Managed frontend failed its public probe and could not be deactivated",
              {
                code: "PROJECT_FRONTEND_ROLLBACK_FAILED",
                context: { projectId: project.id, publicUrl },
                cause: new AggregateError([probeError, rollbackError]),
                severity: "fatal",
              },
            );
          }
          throw probeError;
        }
        hosting = "managed-frontend";
        publishedApp = activated.app;
      } else {
        const repoUrl = project.repoUrl;
        const ref = intent.value.ref;
        if (!repoUrl || !ref) {
          throw new ElizaError(
            "Validated container publication lost its repository or commit",
            {
              code: "PROJECT_CONTAINER_INPUT_LOST",
              context: { projectId: project.id },
              severity: "fatal",
            },
          );
        }
        const deployInput: DeployAppInput = {
          repoUrl,
          ref,
          ...(intent.value.dockerfile
            ? { dockerfile: intent.value.dockerfile }
            : {}),
        };
        await client.deployApp(app.id, deployInput);
        await callback?.({
          text: `Publishing "${project.name}" container… I’ll confirm only after it is live.`,
          actions: [ACTION],
        });
        const config = DEFAULT_DEPLOY_GATE_CONFIG;
        const gate = await runDeployGate(
          {
            getStatus: (signal) =>
              client.getAppDeployStatus(app.id, { signal }),
            getApp: (signal) => client.getApp(app.id, { signal }),
            probe: (url) =>
              probeReachable(url, { timeoutMs: config.probeTimeoutMs }),
            onPollError: (err, attempt) =>
              logger.warn(
                {
                  error: err,
                  projectId: project.id,
                  attempt,
                },
                "[PUBLISH_PROJECT] Container status poll failed; deploy continues",
              ),
          },
          config,
        );
        if (gate.phase !== "ready" || !gate.url) {
          throw new ElizaError(
            `Container publication was not confirmed live (${gate.phase})`,
            {
              code: "PROJECT_CONTAINER_NOT_LIVE",
              context: {
                projectId: project.id,
                phase: gate.phase,
                status: gate.status,
                url: gate.url,
              },
              severity: "ephemeral",
            },
          );
        }
        publicUrl = gate.url;
        hosting = "container";
        publishedApp = (
          await client.updateApp(app.id, {
            name: publishName,
            description: publishDescription,
            app_url: publicUrl,
            allowed_origins: [publicUrl],
            is_active: true,
          })
        ).app;
      }

      if (!publishedApp) {
        throw new ElizaError("Publication completed without a Cloud app row", {
          code: "PROJECT_PUBLISH_RESULT_MISSING",
          context: { projectId: project.id, cloudAppId: app.id },
          severity: "fatal",
        });
      }
      invalidateAppsCache(runtime);
      await recordAppDeployFact(runtime, message, publishedApp, publicUrl);
      const reply = `"${project.name}" is published at ${publicUrl}.`;
      await callback?.({ text: reply, actions: [ACTION] });
      return {
        success: true,
        text: `Published project ${project.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          project: {
            id: project.id,
            name: project.name,
            cloudAppId: app.id,
          },
          app: {
            id: publishedApp.id,
            name: publishedApp.name,
            slug: publishedApp.slug,
          },
          published: true,
          hosting,
          publicUrl,
          createdCloudRecord,
          apiKeyCreated: createdCloudRecord,
        },
      };
    } catch (err) {
      // error-policy:J1 action boundary keeps failed publication observable.
      logger.error(
        {
          error: err,
          projectId: projectForFailure?.id,
          cloudAppId: projectForFailure?.cloudAppId,
        },
        "[PUBLISH_PROJECT] Project publication failed",
      );
      const detail = err instanceof Error ? err.message : String(err);
      const reply = `${ERROR_MESSAGE}\nCloud reported: ${detail}`;
      await callback?.({ text: reply, actions: [ACTION] });
      return {
        success: false,
        text: "Project publication failed.",
        userFacingText: reply,
        error: err instanceof Error ? err : new Error(detail),
        data: {
          reason: "error",
          projectId: projectForFailure?.id,
          cloudAppId: projectForFailure?.cloudAppId,
        },
      };
    }
  },
};

export default publishProjectAction;
