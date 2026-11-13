import { runWithCloudBindingsAsync } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import {
  revokeInferenceApiKey,
  revokeInferenceSessionsThrough,
  setInferenceOrganizationActive,
} from "@elizaos/cloud-shared/lib/services/inference-credential-revocation";
import { InferenceAdmissionGate as ProductionInferenceAdmissionGate } from "../../src/inference-admission-gate";
import { SpeechRelayCoordinator } from "../../src/speech-relay-coordinator";

export class TestSpeechRelayCoordinator extends SpeechRelayCoordinator {
  constructor(
    private readonly fixtureState: DurableObjectState,
    env: ConstructorParameters<typeof SpeechRelayCoordinator>[1],
  ) {
    super(fixtureState, env);
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const stats = ((globalThis as any).__speechStats ??= {});
    if (path === "/test-bootstrap-state") {
      const storage = this.fixtureState.storage;
      const record = await storage.get<{ phase: string; expiresAt: number }>(
        "session",
      );
      return Response.json({
        phase: record?.phase ?? null,
        expiresAt: record?.expiresAt ?? null,
        alarmAt: await storage.getAlarm(),
      });
    }
    if (path === "/test-ledger")
      return Response.json(
        (await this.fixtureState.storage.get("session")) ?? null,
      );
    if (path === "/test-expire-preparation") {
      // Advance only the persisted expiry fact; the production mint transition
      // must still reject it before any provider or admission work.
      const record =
        await this.fixtureState.storage.get<Record<string, unknown>>("session");
      if (record?.phase !== "prepared")
        return new Response(null, { status: 409 });
      await this.fixtureState.storage.put("session", {
        ...record,
        expiresAt: Date.now() - 1,
      });
      return Response.json({ expired: true });
    }
    if (
      path === "/test-hold-import" ||
      path === "/test-release-import" ||
      path === "/test-reject-import"
    ) {
      const { kind } = (await request.json()) as { kind: string };
      if (kind !== "upgrade" && kind !== "opening" && kind !== "closing")
        return new Response(null, { status: 400 });
      if (path === "/test-hold-import") stats[`${kind}HoldImport`] = true;
      else if (path === "/test-reject-import")
        stats[`${kind}RejectImport`] = true;
      else {
        stats[`${kind}ReleaseImport`]?.();
        delete stats[`${kind}ReleaseImport`];
      }
      return Response.json({ configured: true });
    }
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
    if (path === "/test-unknown-tts") {
      stats.ttsUnknown = true;
      return Response.json(stats);
    }
    if (path === "/test-force-alarm") {
      await this.alarm().catch(() => {});
      return Response.json(stats);
    }
    if (path === "/test-stt-drain-mode") {
      const body = (await request.json()) as { unknown: boolean };
      stats.sttDrainUnknown = body.unknown === true;
      return Response.json({ configured: true });
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
/** Count a real accepted revocation fence per isolated test organization. */
export class InferenceAdmissionGate extends ProductionInferenceAdmissionGate {
  override async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    if (
      new URL(request.url).pathname === "/speech/subscribe" &&
      response.status === 101
    ) {
      const identity = JSON.parse(
        request.headers.get("X-Eliza-Speech-Identity") ?? "null",
      ) as { organizationId?: string } | null;
      if (identity?.organizationId) {
        const target = globalThis as unknown as {
          __speechStats?: { speechFenceCounts?: Record<string, number> };
        };
        target.__speechStats ??= {};
        target.__speechStats.speechFenceCounts ??= {};
        const counts = target.__speechStats.speechFenceCounts;
        counts[identity.organizationId] =
          (counts[identity.organizationId] ?? 0) + 1;
      }
    }
    return response;
  }
}
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
