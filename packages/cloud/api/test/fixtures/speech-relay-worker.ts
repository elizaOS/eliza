import { runWithCloudBindingsAsync } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import {
  revokeInferenceApiKey,
  revokeInferenceSessionsThrough,
  setInferenceOrganizationActive,
} from "@elizaos/cloud-shared/lib/services/inference-credential-revocation";
import { InferenceAdmissionGate } from "../../src/inference-admission-gate";
import { SpeechRelayCoordinator } from "../../src/speech-relay-coordinator";

export class TestSpeechRelayCoordinator extends SpeechRelayCoordinator {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const stats = ((globalThis as any).__speechStats ??= {});
    if (path === "/test-lock-bootstrap") {
      stats.locked = true;
      return Response.json(stats);
    }
    if (path === "/test-allow-settlement") {
      stats.locked = false;
      return Response.json(stats);
    }
    if (path === "/test-allow-admission") {
      stats.decline = false;
      stats.locked = false;
      return Response.json(stats);
    }
    if (path === "/test-decline") {
      stats.decline = true;
      return Response.json(stats);
    }
    if (path === "/test-stats") return Response.json(stats);
    // Exercise the staging-only timings gate without a second worker.
    const environment = request.headers.get("x-test-environment");
    if (environment)
      (this as unknown as { env: Record<string, unknown> }).env = {
        ...(this as unknown as { env: Record<string, unknown> }).env,
        ENVIRONMENT: environment,
      };
    return super.fetch(request);
  }
}
export { InferenceAdmissionGate };
export default {
  fetch(
    request: Request,
    env: {
      SESSIONS: DurableObjectNamespace;
      INFERENCE_ADMISSION_GATES: DurableObjectNamespace;
    },
  ) {
    if (new URL(request.url).pathname === "/test-lifecycle") {
      return runWithCloudBindingsAsync(
        env as Record<string, unknown>,
        async () => {
          const body = (await request.json()) as Record<
            string,
            string | number | boolean
          >;
          const org = String(body.organizationId);
          if (body.path === "/organization/set-active")
            await setInferenceOrganizationActive(org, body.active === true);
          else if (body.path === "/credential/revoke")
            await revokeInferenceApiKey(org, String(body.credentialId));
          else if (body.path === "/session/revoke-through")
            await revokeInferenceSessionsThrough(
              org,
              String(body.userId),
              Number(body.issuedAt),
            );
          else return new Response(null, { status: 400 });
          return Response.json({ committed: true });
        },
      );
    }
    if (new URL(request.url).pathname.startsWith("/test-gate/")) {
      const url = new URL(request.url);
      url.pathname = url.pathname.slice("/test-gate".length);
      return env.INFERENCE_ADMISSION_GATES.getByName(
        request.headers.get("x-test-org") ??
          "22222222-2222-4222-8222-222222222222",
      ).fetch(new Request(url, request));
    }
    const name = request.headers.get("x-test-session") ?? "test";
    return env.SESSIONS.get(env.SESSIONS.idFromName(name)).fetch(request);
  },
};
