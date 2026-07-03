import { Hono } from "hono";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { vertexModelRegistryService } from "@/lib/services/vertex-model-registry";
import {
  getTuningJobStatus,
  listTuningJobs,
} from "@/lib/services/vertex-tuning";
import type { AppEnv } from "@/types/cloud-worker-env";

async function __hono_GET(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { searchParams } = new URL(request.url);
    const projectId =
      searchParams.get("projectId") || process.env.GOOGLE_CLOUD_PROJECT;
    const region = searchParams.get("region") || "us-central1";
    const jobName = searchParams.get("name");
    const jobId = searchParams.get("jobId");
    const persistedOnly = searchParams.get("persisted") === "true";

    const viewer = {
      organizationId: user.organization_id,
      userId: user.id,
    };

    if (jobId) {
      const synced = await vertexModelRegistryService.syncJobStatus({
        jobId,
        viewer,
      });
      if (!synced) {
        return Response.json(
          { error: "Tracked Vertex job not found" },
          { status: 404 },
        );
      }

      return Response.json({
        job: synced.job.last_remote_payload,
        jobRecord: synced.job,
        tunedModelRecord: synced.tunedModel,
      });
    }

    if (jobName) {
      // Gate on the OWNED persisted record first — otherwise the direct Vertex
      // fetch would leak a sibling org's (enumerable) tuning job config.
      const synced = await vertexModelRegistryService.syncJobStatus({
        vertexJobName: jobName,
        viewer,
      });
      if (!synced) {
        return Response.json(
          { error: "Tracked Vertex job not found" },
          { status: 404 },
        );
      }

      const job = await getTuningJobStatus(jobName);
      return Response.json({
        job,
        jobRecord: synced.job,
        tunedModelRecord: synced.tunedModel,
      });
    }

    const persistedJobs = await vertexModelRegistryService.listVisibleJobs({
      organizationId: user.organization_id,
      userId: user.id,
    });

    if (persistedOnly) {
      return Response.json({ persistedJobs });
    }

    if (!projectId) {
      return Response.json(
        {
          error:
            "projectId is required. Set it in the query string or provide GOOGLE_CLOUD_PROJECT.",
        },
        { status: 400 },
      );
    }

    const jobs = await listTuningJobs(projectId, region);
    return Response.json({ jobs, persistedJobs });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to query Vertex jobs",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => __hono_GET(c.req.raw));
export default __hono_app;
