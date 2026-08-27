/**
 * /cloud/billing/payments/:id — single payment-state detail (#22966 linked
 * order/receipt surface). Loads one server-authoritative row by its stable
 * projection id from GET /api/v1/billing/payment-states/:id; distinct
 * loading / not-found / error / success states per the repo error policy.
 */

import { Button, DashboardLoadingState } from "@elizaos/ui/cloud-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../lib/api-client";
import { useCloudT } from "../shell/CloudI18nProvider";
import type { PaymentStateDisplay } from "./components/payment-activity-card";
import { PaymentStateDetailClient } from "./components/payment-state-detail-client";
import { isPaymentStateRow } from "./components/payment-state-row-validation";

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
  // Monotonic generation counter: every in-flight fetch captures the current
  // value, and only the most recent generation may commit state. A delayed
  // completion for a previous route id (the fetch closes over `id`) must
  // never overwrite the row the user navigated to next — /payments/B must
  // never render payment A's amount, receipt, or authority.
  const generation = useRef(0);

  const fetchState = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setPhase({ kind: "loading" });
    if (!id) {
      setPhase({ kind: "not-found" });
      return;
    }
    try {
      const data = await api<PaymentStateResponse>(
        `/api/v1/billing/payment-states/${encodeURIComponent(id)}`,
      );
      if (requestGeneration !== generation.current) {
        return;
      }
      // A malformed success response is an error state, never a healthy
      // row: every rendered field is required by the route contract, so a
      // partial payload fails validation instead of rendering fabricated
      // values.
      if (!data || !isPaymentStateRow(data.state)) {
        setPhase({
          kind: "error",
          message: "Payment state response was malformed.",
        });
        return;
      }
      if (data.state.id !== id) {
        // The route contract binds the detail to the requested id; a
        // mismatched row is malformed for this route, not a renderable
        // success.
        setPhase({
          kind: "error",
          message: "Payment state response was malformed.",
        });
        return;
      }
      setPhase({ kind: "ready", row: data.state });
    } catch (error) {
      if (requestGeneration !== generation.current) {
        return;
      }
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
    // Gate the queued fetch on this effect instance: if the component
    // unmounts (or the id changes) BEFORE the queued microtask runs, the
    // cancelled flag prevents it from ever starting — a bare generation
    // bump in cleanup alone would be defeated by the microtask's own
    // ++generation.current when it runs afterwards.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void fetchState();
      }
    });
    return () => {
      cancelled = true;
      // Effect cleanup runs on EVERY id transition and on unmount, BEFORE
      // the new id's queued fetch begins — closing the window where a
      // previous id's in-flight completion still matched the current
      // generation (its fetch had not started yet, so the counter had not
      // advanced). Any completion racing a cleanup now observes a stale
      // generation and must not commit state.
      generation.current += 1;
    };
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
        <Button
          variant="ghost"
          type="button"
          onClick={() => navigate("/settings#cloud-billing")}
          className="text-xs font-mono text-txt-strong underline uppercase hover:text-txt transition-colors"
        >
          {t("cloud.paymentStateDetail.backToBillingLink", {
            defaultValue: "Back to billing",
          })}
        </Button>
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
        <Button
          variant="ghost"
          type="button"
          onClick={() => void fetchState()}
          className="text-xs font-mono text-txt-strong underline uppercase hover:text-txt transition-colors"
        >
          {t("cloud.billingTab.paymentActivityRetry", {
            defaultValue: "Retry",
          })}
        </Button>
      </div>
    );
  }

  return <PaymentStateDetailClient row={phase.row} />;
}
