/**
 * /cloud/billing/payments/:id — single payment-state detail (#22966 linked
 * order/receipt surface). Loads one server-authoritative row by its stable
 * projection id from GET /api/v1/billing/payment-states/:id; distinct
 * loading / not-found / error / success states per the repo error policy.
 */

import { DashboardLoadingState } from "@elizaos/ui/cloud-ui";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../lib/api-client";
import { useCloudT } from "../shell/CloudI18nProvider";
import type { PaymentStateDisplay } from "./components/payment-activity-card";
import { PaymentStateDetailClient } from "./components/payment-state-detail-client";

type DetailPhase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "not-found" }
  | { kind: "ready"; row: PaymentStateDisplay };

interface PaymentStateResponse {
  state: PaymentStateDisplay;
}

export default function PaymentStateDetailPage() {
  const t = useCloudT();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<DetailPhase>({ kind: "loading" });

  const fetchState = useCallback(async () => {
    setPhase({ kind: "loading" });
    if (!id) {
      setPhase({ kind: "not-found" });
      return;
    }
    try {
      const data = await api<PaymentStateResponse>(
        `/api/v1/billing/payment-states/${encodeURIComponent(id)}`,
      );
      // A malformed success response is an error state, never a healthy
      // row: `state` is required by the route contract.
      if (
        !data ||
        typeof data !== "object" ||
        typeof data.state !== "object" ||
        data.state === null ||
        typeof data.state.id !== "string" ||
        typeof data.state.paymentState !== "string"
      ) {
        setPhase({
          kind: "error",
          message: "Payment state response was malformed.",
        });
        return;
      }
      setPhase({ kind: "ready", row: data.state });
    } catch (error) {
      // A 404 from the authoritative endpoint is a distinct not-found state,
      // not a generic error — the linked row may have scrolled out of the
      // projection window or the id may simply be stale.
      if (error instanceof ApiError && error.status === 404) {
        setPhase({ kind: "not-found" });
        return;
      }
      // error-policy:J4 transport failure becomes a visible error state with
      // an explicit retry action — never a silent blank page.
      setPhase({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Payment detail could not be loaded.",
      });
    }
  }, [id]);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchState();
    });
  }, [fetchState]);

  const loadingLabel = t("cloud.paymentStateDetail.loading", {
    defaultValue: "Loading payment detail",
  });

  if (phase.kind === "loading") {
    return <DashboardLoadingState label={loadingLabel} />;
  }

  if (phase.kind === "not-found") {
    return (
      <div className="flex flex-col items-center gap-3 p-8 border border-brand-surface max-w-6xl mx-auto m-6">
        <p
          className="text-xs md:text-sm text-muted-strong font-mono"
          data-testid="payment-detail-not-found"
        >
          {t("cloud.paymentStateDetail.notFound", {
            defaultValue: "This payment could not be found in your history.",
          })}
        </p>
        <button
          type="button"
          onClick={() => navigate("/settings#cloud-billing")}
          className="text-xs font-mono text-txt-strong underline uppercase hover:text-txt transition-colors"
        >
          {t("cloud.paymentStateDetail.backToBillingLink", {
            defaultValue: "Back to billing",
          })}
        </button>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="flex flex-col items-center gap-3 p-8 border border-brand-surface max-w-6xl mx-auto m-6">
        <p
          className="text-xs md:text-sm text-red-300 font-mono"
          data-testid="payment-detail-error"
        >
          {t("cloud.paymentStateDetail.loadFailed", {
            defaultValue: "Payment detail could not be loaded",
          })}
        </p>
        <p className="text-xs text-muted-strong font-mono">{phase.message}</p>
        <button
          type="button"
          onClick={() => void fetchState()}
          className="text-xs font-mono text-txt-strong underline uppercase hover:text-txt transition-colors"
        >
          {t("cloud.billingTab.paymentActivityRetry", {
            defaultValue: "Retry",
          })}
        </button>
      </div>
    );
  }

  return <PaymentStateDetailClient row={phase.row} />;
}
