// @ts-nocheck — mixin: type safety is enforced on the composed class
import type {
  LifeOpsConnectorSide,
  LifeOpsTelegramCapability,
  LifeOpsTelegramConnectorStatus,
  StartLifeOpsTelegramAuthRequest,
  StartLifeOpsTelegramAuthResponse,
  SubmitLifeOpsTelegramAuthRequest,
} from "@elizaos/shared/contracts/lifeops";
import {
  LIFEOPS_TELEGRAM_CAPABILITIES,
} from "@elizaos/shared/contracts/lifeops";
import { createLifeOpsConnectorGrant } from "./repository.js";
import {
  fail,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";
import {
  buildTelegramTokenRef,
  cancelTelegramAuth,
  deleteStoredTelegramToken,
  findPendingTelegramAuthSession,
  readStoredTelegramToken,
  startTelegramAuth as startTelegramAuthFlow,
  submitTelegramAuthCode,
  submitTelegramAuthPassword,
} from "./telegram-auth.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

/** @internal */
export function withTelegram<TBase extends Constructor<LifeOpsServiceBase>>(Base: TBase) {
  class LifeOpsTelegramServiceMixin extends Base {
    async getTelegramConnectorStatus(
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsTelegramConnectorStatus> {
      const side =
        normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "telegram",
        "local",
      );

      const tokenRef = grant?.tokenRef ?? null;
      const storedToken = tokenRef
        ? readStoredTelegramToken(tokenRef)
        : null;
      const connected = Boolean(grant && storedToken);

      const capabilities = (grant?.capabilities ?? []).filter(
        (candidate): candidate is LifeOpsTelegramCapability =>
          candidate === "telegram.read" || candidate === "telegram.send",
      );

      return {
        provider: "telegram",
        side,
        connected,
        reason: connected
          ? "connected"
          : grant
            ? "auth_expired"
            : "disconnected",
        identity:
          storedToken?.identity &&
          Object.keys(storedToken.identity).length > 0
            ? storedToken.identity
            : grant?.identity &&
                Object.keys(grant.identity).length > 0
              ? (grant.identity as LifeOpsTelegramConnectorStatus["identity"])
              : null,
        grantedCapabilities: capabilities,
        grant: grant ?? null,
      };
    }

    async startTelegramAuth(
      request: StartLifeOpsTelegramAuthRequest,
    ): Promise<StartLifeOpsTelegramAuthResponse> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
      const phone = requireNonEmptyString(request.phone, "phone");

      const session = startTelegramAuthFlow({
        agentId: this.agentId(),
        side,
        phone,
        apiId: request.apiId,
        apiHash: request.apiHash,
      });

      return {
        provider: "telegram",
        side,
        state: session.state === "idle" ? "waiting_for_code" : session.state as StartLifeOpsTelegramAuthResponse["state"],
        error: session.error ?? undefined,
      };
    }

    async submitTelegramAuth(
      request: SubmitLifeOpsTelegramAuthRequest,
    ): Promise<StartLifeOpsTelegramAuthResponse> {
      const side =
        normalizeOptionalConnectorSide(request.side, "side") ?? "owner";

      // Determine which submission to make based on presence of code vs password.
      // The client sends code first; if 2FA is needed, a second request with password follows.
      let resultState: StartLifeOpsTelegramAuthResponse["state"];
      let resultError: string | undefined;

      if (request.code) {
        const session = findPendingTelegramAuthSession(this.agentId(), side);
        if (!session) {
          fail(404, "No pending Telegram auth session found for this agent/side.");
        }
        const result = submitTelegramAuthCode(session.sessionId, request.code);
        resultState = result.state as StartLifeOpsTelegramAuthResponse["state"];
        resultError = result.error ?? undefined;

        if (result.state === "connected") {
          await this.persistTelegramGrant(side, result.phone);
          cancelTelegramAuth(result.sessionId);
        }
      } else if (request.password) {
        const session = findPendingTelegramAuthSession(this.agentId(), side);
        if (!session) {
          fail(404, "No pending Telegram auth session found for this agent/side.");
        }
        const result = submitTelegramAuthPassword(
          session.sessionId,
          request.password,
        );
        resultState = result.state as StartLifeOpsTelegramAuthResponse["state"];
        resultError = result.error ?? undefined;

        if (result.state === "connected") {
          await this.persistTelegramGrant(side, result.phone);
          cancelTelegramAuth(result.sessionId);
        }
      } else {
        fail(400, "Either code or password must be provided.");
      }

      return {
        provider: "telegram",
        side,
        state: resultState,
        error: resultError,
      };
    }

    async disconnectTelegram(
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsTelegramConnectorStatus> {
      const side =
        normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
      const grant = await this.repository.getConnectorGrant(
        this.agentId(),
        "telegram",
        "local",
      );

      if (grant?.tokenRef) {
        deleteStoredTelegramToken(grant.tokenRef);
      }

      if (grant) {
        await this.repository.deleteConnectorGrant(
          this.agentId(),
          "telegram",
          "local",
        );
      }

      await this.recordConnectorAudit(
        `telegram:${side}`,
        "telegram connector disconnected",
        { side },
        { disconnected: true },
      );

      return {
        provider: "telegram",
        side,
        connected: false,
        reason: "disconnected",
        identity: null,
        grantedCapabilities: [],
        grant: null,
      };
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    private async persistTelegramGrant(
      side: LifeOpsConnectorSide,
      phone: string,
    ): Promise<void> {
      const tokenRef = buildTelegramTokenRef(this.agentId(), side);
      const storedToken = readStoredTelegramToken(tokenRef);
      const identity: Record<string, unknown> = storedToken?.identity
        ? { ...storedToken.identity, phone }
        : { phone };

      const existing = await this.repository.getConnectorGrant(
        this.agentId(),
        "telegram",
        "local",
      );

      const capabilities: LifeOpsTelegramCapability[] = [
        ...LIFEOPS_TELEGRAM_CAPABILITIES,
      ];

      const grant = existing
        ? {
            ...existing,
            identity,
            capabilities,
            tokenRef,
            metadata: {
              ...existing.metadata,
              phone,
            },
            updatedAt: new Date().toISOString(),
          }
        : createLifeOpsConnectorGrant({
            agentId: this.agentId(),
            provider: "telegram",
            identity,
            grantedScopes: [],
            capabilities,
            tokenRef,
            mode: "local",
            side,
            metadata: { phone },
            lastRefreshAt: new Date().toISOString(),
          });

      await this.repository.upsertConnectorGrant(grant);

      await this.recordConnectorAudit(
        `telegram:${side}`,
        "telegram connector authenticated",
        { phone, side },
        { capabilities },
      );
    }
  }

  return LifeOpsTelegramServiceMixin;
}

