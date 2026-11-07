import {
  buildAuthenticationState,
  importCloudflareAuthenticationState,
} from "../../../shared/src/lib/auth/authentication-state";
import {
  isJtiRevoked,
  revokeInternalToken,
} from "../../../shared/src/lib/auth/jwt-internal-denylist";
import { runWithCloudBindingsAsync } from "../../../shared/src/lib/runtime/cloud-bindings";
import {
  issueNonce,
  validateAndConsumeSIWE,
} from "../../../shared/src/lib/utils/siwe-helpers";
import {
  consumeConsentNonce,
  issueConsentNonce,
} from "../../../shared/src/lib/voice-session/consent-nonce";
import {
  claimVoiceSessionToken,
  lookupVoiceSessionJti,
  recordVoiceSessionJti,
} from "../../../shared/src/lib/voice-session/jwt";
import type { RuntimeDurableObjectNamespace } from "../../../shared/src/types/cloud-worker-env";

export { AuthenticationState } from "../../src/authentication-state";

export default {
  async fetch(
    request: Request,
    env: { AUTHENTICATION_STATE: RuntimeDurableObjectNamespace },
  ) {
    const input = (await request.json()) as {
      organization?: string;
      user?: string;
      operation: string;
      key: string;
      value?: string;
      seconds?: number;
      expiresAt?: number;
      nonce?: string;
      message?: string;
      signature?: `0x${string}`;
    };
    const bindings = { ...env, CLOUD_AUTH_STATE_BACKEND: "cloudflare" };
    if (input.operation === "import") {
      try {
        return Response.json(
          await importCloudflareAuthenticationState(
            env.AUTHENTICATION_STATE,
            {
              key: input.key,
              value: input.value ?? "",
              expiresAt: input.expiresAt ?? 0,
            },
            true,
          ),
        );
      } catch {
        return new Response("Import rejected", { status: 409 });
      }
    }

    if (input.operation === "missing-binding") {
      return runWithCloudBindingsAsync(
        { CLOUD_AUTH_STATE_BACKEND: "cloudflare" },
        async () => {
          try {
            await consumeConsentNonce(input.key, input.nonce ?? "");
          } catch {
            return new Response("Unavailable", { status: 503 });
          }
          return new Response("Unexpected acceptance", { status: 500 });
        },
      );
    }

    return runWithCloudBindingsAsync(bindings, async () => {
      if (input.operation === "record-session") {
        await recordVoiceSessionJti({
          organizationId: input.organization ?? "org-a",
          userId: input.user ?? "user-a",
          sessionId: input.key,
          jti: "directory-jti",
          expSeconds: Math.floor(Date.now() / 1000) + 60,
        });
        return Response.json(true);
      }
      if (input.operation === "lookup-session")
        return Response.json(
          await lookupVoiceSessionJti(
            input.organization ?? "org-a",
            input.user ?? "user-a",
            input.key,
          ),
        );

      if (input.operation === "claim-voice")
        return Response.json(
          await claimVoiceSessionToken(
            input.key,
            Math.floor(Date.now() / 1000) + 60,
          ),
        );
      if (input.operation === "revoke") {
        await revokeInternalToken(input.key);
        return Response.json(true);
      }
      if (input.operation === "is-revoked")
        return Response.json(await isJtiRevoked(input.key));
      if (input.operation === "issue-consent")
        return Response.json(await issueConsentNonce(input.key));
      if (input.operation === "consume-consent")
        return Response.json(
          await consumeConsentNonce(input.key, input.nonce ?? ""),
        );
      const state = buildAuthenticationState(
        bindings,
        env.AUTHENTICATION_STATE,
      );
      if (!state) throw new Error("State missing");
      if (input.operation === "issue-siwe")
        return Response.json(
          await issueNonce(state, {
            uri: "https://auth-state.test",
            chainId: 1,
          }),
        );
      if (input.operation === "verify-siwe") {
        try {
          return Response.json(
            await validateAndConsumeSIWE(
              state,
              input.message ?? "",
              input.signature ?? "0x",
              "auth-state.test",
            ),
          );
        } catch {
          return Response.json({ rejected: true }, { status: 401 });
        }
      }
      if (input.operation === "set")
        return Response.json(
          await state.setex(input.key, input.seconds ?? 30, input.value ?? ""),
        );
      if (input.operation === "getdel")
        return Response.json(await state.getdel(input.key));
      if (input.operation === "get")
        return Response.json(await state.get(input.key));
      throw new Error("Invalid fixture operation");
    });
  },
};
