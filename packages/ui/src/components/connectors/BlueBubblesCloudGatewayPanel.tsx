/**
 * Enrolls a user-owned BlueBubbles Mac relay with Eliza Cloud. Each inbound
 * sender resolves to that sender's linked agent; unknown senders continue into
 * secure Cloud sign-in and provisioning. Apple and BlueBubbles credentials
 * remain local, while the revocable relay credential is displayed only once.
 */

import { Check, Copy, RefreshCw, Smartphone, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import {
  type CloudBlueBubblesGateway,
  type CloudBlueBubblesRegistration,
  type CloudBlueBubblesRegistrationRequest,
  client,
} from "../../api";
import { useAppSelectorShallow } from "../../state";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { StatusBadge, type StatusTone } from "../ui/status-badge";

export interface BlueBubblesCloudGatewayApi {
  listCloudBlueBubblesGateways(): Promise<{
    success: true;
    data: { gateways: CloudBlueBubblesGateway[] };
  }>;
  registerCloudBlueBubblesGateway(
    request: CloudBlueBubblesRegistrationRequest,
  ): Promise<{ success: true; data: CloudBlueBubblesRegistration }>;
  revokeCloudBlueBubblesGateway(gatewayId: string): Promise<{ success: true }>;
}

export interface BlueBubblesCloudGatewayInitialData {
  gateways: CloudBlueBubblesGateway[];
}

type GatewayView = Omit<CloudBlueBubblesGateway, "userId">;

function gatewayTone(status: GatewayView["status"]): StatusTone {
  if (status === "connected") return "success";
  if (status === "offline") return "danger";
  return "warning";
}

function relayEnvironmentText(
  registration: CloudBlueBubblesRegistration,
): string {
  return Object.entries(registration.relayEnvironment)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function toGatewayView(gateway: CloudBlueBubblesGateway): GatewayView {
  return {
    id: gateway.id,
    bridgeId: gateway.bridgeId,
    phoneNumber: gateway.phoneNumber,
    friendlyName: gateway.friendlyName,
    routingMode: gateway.routingMode,
    agentId: gateway.agentId,
    lastSeenAt: gateway.lastSeenAt,
    status: gateway.status,
  };
}

export function BlueBubblesCloudGatewayPanel({
  api = client,
  initialData,
}: {
  api?: BlueBubblesCloudGatewayApi;
  /** Deterministic preloaded state for visual stories and embedded hosts. */
  initialData?: BlueBubblesCloudGatewayInitialData;
}) {
  const { elizaCloudConnected, setActionNotice } = useAppSelectorShallow(
    (s) => ({
      elizaCloudConnected: s.elizaCloudConnected,
      setActionNotice: s.setActionNotice,
    }),
  );
  const [gateways, setGateways] = useState<GatewayView[]>(
    initialData?.gateways.map(toGatewayView) ?? [],
  );
  const [phoneNumber, setPhoneNumber] = useState("");
  const [friendlyName, setFriendlyName] = useState("");
  const [loading, setLoading] = useState(elizaCloudConnected && !initialData);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registration, setRegistration] =
    useState<CloudBlueBubblesRegistration | null>(null);
  const [revokeConfirmationId, setRevokeConfirmationId] = useState<
    string | null
  >(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!elizaCloudConnected) return;
    setLoading(true);
    setError(null);
    try {
      const gatewayResponse = await api.listCloudBlueBubblesGateways();
      setGateways(gatewayResponse.data.gateways.map(toGatewayView));
    } catch (cause) {
      // error-policy:J4 Cloud enrollment failures render an explicit unavailable state.
      setError(
        cause instanceof Error
          ? cause.message
          : "The iPhone gateway could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [api, elizaCloudConnected]);

  useEffect(() => {
    if (initialData) return;
    void refresh();
  }, [initialData, refresh]);

  const handleRegister = async (event: FormEvent) => {
    event.preventDefault();
    if (!phoneNumber.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await api.registerCloudBlueBubblesGateway({
        routingMode: "sender-owned",
        phoneNumber: phoneNumber.trim(),
        ...(friendlyName.trim() ? { friendlyName: friendlyName.trim() } : {}),
      });
      setRegistration(response.data);
      setGateways((current) => [
        {
          id: response.data.id,
          bridgeId: response.data.bridgeId,
          phoneNumber: response.data.phoneNumber,
          friendlyName: friendlyName.trim() || null,
          routingMode: response.data.routingMode,
          agentId: response.data.agentId,
          lastSeenAt: null,
          status: "registered",
        },
        ...current.filter((gateway) => gateway.id !== response.data.id),
      ]);
      setPhoneNumber("");
      setFriendlyName("");
      setActionNotice(
        "Phone gateway registered. Copy the relay configuration now; its token is shown only once.",
        "success",
        5000,
      );
    } catch (cause) {
      // error-policy:J4 Registration failure remains visible and preserves form input.
      const message =
        cause instanceof Error
          ? cause.message
          : "The iPhone gateway could not be registered.";
      setError(message);
      setActionNotice(message, "error", 5000);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyRegistration = async () => {
    if (!registration) return;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable in this app session.");
      }
      await navigator.clipboard.writeText(relayEnvironmentText(registration));
      setActionNotice("Relay configuration copied.", "success", 2500);
    } catch (cause) {
      // error-policy:J4 Clipboard failures are reported without hiding the credential.
      setActionNotice(
        cause instanceof Error
          ? cause.message
          : "Relay configuration could not be copied.",
        "error",
        4200,
      );
    }
  };

  const handleRevoke = async (gatewayId: string) => {
    if (revokingId) return;
    setRevokingId(gatewayId);
    setError(null);
    try {
      await api.revokeCloudBlueBubblesGateway(gatewayId);
      setGateways((current) =>
        current.filter((gateway) => gateway.id !== gatewayId),
      );
      setRevokeConfirmationId(null);
      if (registration?.id === gatewayId) setRegistration(null);
      setActionNotice("Phone gateway revoked.", "success", 3000);
    } catch (cause) {
      // error-policy:J4 Revocation failure remains visible and leaves the binding intact.
      const message =
        cause instanceof Error
          ? cause.message
          : "The phone gateway could not be revoked.";
      setError(message);
      setActionNotice(message, "error", 4200);
    } finally {
      setRevokingId(null);
    }
  };

  const phoneField = useAgentElement<HTMLInputElement>({
    id: "bluebubbles-cloud-phone-number",
    role: "text-input",
    label: "iPhone phone number",
    group: "connector",
    fillable: true,
    getValue: () => phoneNumber,
    onFill: setPhoneNumber,
  });
  const nameField = useAgentElement<HTMLInputElement>({
    id: "bluebubbles-cloud-friendly-name",
    role: "text-input",
    label: "Phone gateway name",
    group: "connector",
    fillable: true,
    getValue: () => friendlyName,
    onFill: setFriendlyName,
  });
  const registerControl = useAgentElement<HTMLButtonElement>({
    id: "bluebubbles-cloud-register",
    role: "button",
    label: "Register phone gateway",
    group: "connector",
    status: submitting ? "busy" : "ready",
    onActivate: () => {
      const form = phoneField.ref.current?.form;
      form?.requestSubmit();
    },
  });
  const copyControl = useAgentElement<HTMLButtonElement>({
    id: "bluebubbles-cloud-copy-relay-config",
    role: "button",
    label: "Copy one-time relay configuration",
    group: "connector",
    sensitive: true,
    onActivate: () => void handleCopyRegistration(),
  });

  if (!elizaCloudConnected) {
    return (
      <PagePanel.Notice tone="default" className="mt-4">
        <div className="space-y-1 text-sm">
          <div className="font-semibold text-txt">Connect Eliza Cloud</div>
          <div className="text-muted">
            Sign in to register an iPhone number. Each person who texts it is
            routed to their own Eliza agent; first-time texters securely connect
            an Eliza Cloud account. Your Apple ID and BlueBubbles password
            remain on your Mac.
          </div>
        </div>
      </PagePanel.Notice>
    );
  }

  return (
    <div className="mt-4 space-y-4" data-testid="bluebubbles-cloud-gateway">
      <PagePanel.Notice
        tone={error ? "danger" : "accent"}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="Refresh phone gateways"
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
        }
      >
        <div className="space-y-1 text-sm">
          <div className="font-semibold text-txt">iPhone cloud gateway</div>
          <div className="text-muted">
            A Mac running BlueBubbles receives iMessage/SMS for your real
            number. Known senders reach their own linked Eliza agent; new
            senders receive a secure Eliza Cloud sign-in link before their agent
            is provisioned and connected to this conversation.
          </div>
          {error ? <div className="pt-1 text-danger">{error}</div> : null}
        </div>
      </PagePanel.Notice>

      <form
        className="rounded-sm border border-border/50 bg-card/60 p-4"
        onSubmit={(event) => void handleRegister(event)}
      >
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-accent/15 text-accent">
            <Smartphone className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <div className="text-sm font-semibold text-txt">
              Register a phone
            </div>
            <div className="text-xs text-muted">
              The number identifies this bridge. It does not grant access to
              your Apple account.
            </div>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="bluebubbles-phone-number">Phone number</Label>
            <Input
              ref={phoneField.ref}
              id="bluebubbles-phone-number"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+1 415 555 0123"
              value={phoneNumber}
              onChange={(event) => setPhoneNumber(event.target.value)}
              required
              {...phoneField.agentProps}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bluebubbles-friendly-name">Gateway name</Label>
            <Input
              ref={nameField.ref}
              id="bluebubbles-friendly-name"
              placeholder="Office iPhone"
              value={friendlyName}
              onChange={(event) => setFriendlyName(event.target.value)}
              {...nameField.agentProps}
            />
          </div>
        </div>
        <Button
          ref={registerControl.ref}
          type="submit"
          className="mt-4"
          disabled={loading || submitting || !phoneNumber.trim()}
          {...registerControl.agentProps}
        >
          {submitting ? "Registering…" : "Register phone gateway"}
        </Button>
      </form>

      {registration ? (
        <PagePanel.Notice
          tone="accent"
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                ref={copyControl.ref}
                variant="outline"
                size="sm"
                onClick={() => void handleCopyRegistration()}
                {...copyControl.agentProps}
              >
                <Copy /> Copy relay config
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRegistration(null)}
              >
                <Check /> I saved it
              </Button>
            </div>
          }
        >
          <div className="space-y-2 text-sm">
            <div className="font-semibold text-txt">
              Save this relay configuration now
            </div>
            <div className="text-muted">
              The gateway token is shown only once. Save these lines as
              <code className="mx-1 text-muted-strong">
                .eliza-local/bluebubbles-bridge.env
              </code>
              on the Mac running BlueBubbles.
            </div>
            <pre
              data-testid="bluebubbles-relay-environment"
              className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border/50 bg-bg/80 p-3 text-xs text-muted-strong"
            >
              {relayEnvironmentText(registration)}
            </pre>
          </div>
        </PagePanel.Notice>
      ) : null}

      <section
        className="space-y-3"
        aria-labelledby="registered-phone-gateways"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3
              id="registered-phone-gateways"
              className="text-sm font-semibold text-txt"
            >
              Registered phones
            </h3>
            <p className="text-xs text-muted">
              Sender-owned routing keeps every person's agent and conversation
              isolated.
            </p>
          </div>
          <StatusBadge
            label={loading ? "Loading" : String(gateways.length)}
            tone={loading ? "processing" : "muted"}
          />
        </div>
        {!loading && !error && gateways.length === 0 ? (
          <div className="rounded-sm border border-dashed border-border/60 p-4 text-sm text-muted">
            No phone gateway is registered yet.
          </div>
        ) : null}
        {gateways.map((gateway) => {
          const confirming = revokeConfirmationId === gateway.id;
          return (
            <div
              key={gateway.id}
              className="flex flex-col gap-3 rounded-sm border border-border/50 bg-card/50 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-txt">
                    {gateway.friendlyName || gateway.phoneNumber}
                  </span>
                  <StatusBadge
                    label={gateway.status}
                    tone={gatewayTone(gateway.status)}
                    withDot
                  />
                </div>
                <div className="text-xs text-muted">
                  {gateway.phoneNumber} →{" "}
                  {gateway.routingMode === "sender-owned"
                    ? "each sender's Eliza agent"
                    : `fixed agent ${gateway.agentId ?? "unavailable"}`}
                </div>
                {gateway.lastSeenAt ? (
                  <div className="text-xs text-muted">
                    Last relay contact: {gateway.lastSeenAt}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {confirming ? (
                  <>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={revokingId === gateway.id}
                      onClick={() => void handleRevoke(gateway.id)}
                    >
                      {revokingId === gateway.id
                        ? "Revoking…"
                        : "Confirm revoke"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRevokeConfirmationId(null)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRevokeConfirmationId(gateway.id)}
                    aria-label={`Revoke ${gateway.friendlyName || gateway.phoneNumber}`}
                  >
                    <Trash2 /> Revoke
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <div className="rounded-sm border border-border/50 bg-bg-accent/50 p-4 text-xs text-muted">
        <div className="mb-2 font-semibold text-txt">Mac relay checklist</div>
        <ol className="list-decimal space-y-1 pl-4">
          <li>Open BlueBubbles on the Mac signed into this iPhone number.</li>
          <li>Save the one-time environment above on that Mac.</li>
          <li>
            Start the elizaOS relay. It registers
            <code className="mx-1 text-muted-strong">
              http://127.0.0.1:8795/webhooks/bluebubbles
            </code>
            with BlueBubbles automatically.
          </li>
        </ol>
      </div>
    </div>
  );
}
