/** Manages app-owned signed billing callbacks with one-time server-key disclosure and explicit installation before activation. */
import type { AppBillingAdminClient } from "@elizaos/cloud-sdk/app-billing-admin";
import type { AppBillingNotificationConfig } from "@elizaos/cloud-sdk/app-notifications";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Input } from "../../../components/ui/input";
export interface AppNotificationSettingsProps {
  client: AppBillingAdminClient;
  appId: string;
  clientRegistrationId: string;
  environment: "test" | "live";
}
export function AppNotificationSettings(props: AppNotificationSettingsProps) {
  return (
    <NotificationConfig
      key={`${props.appId}:${props.clientRegistrationId}:${props.environment}`}
      {...props}
    />
  );
}
function NotificationConfig({
  client,
  appId,
  clientRegistrationId,
  environment,
}: AppNotificationSettingsProps) {
  const [config, setConfig] = useState<AppBillingNotificationConfig | null>(
    null,
  );
  const [endpoint, setEndpoint] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const locked = useRef(false);
  const id = useId();
  const pendingKey = useRef<string | null>(null);
  const accept = useCallback(
    (next: AppBillingNotificationConfig) => {
      if (next.appId !== appId || next.environment !== environment)
        throw new Error(
          "Notification settings returned a different app or environment",
        );
      if (mounted.current) {
        if (pendingKey.current !== next.pendingKeyId) {
          setSecret(null);
          setInstalled(false);
          pendingKey.current = next.pendingKeyId;
        }
        setConfig(next);
        setEndpoint(next.endpointUrl ?? "");
        setEnabled(next.enabled);
        setReady(true);
      }
    },
    [appId, environment],
  );
  const reload = useCallback(async () => {
    setReady(false);
    accept((await client.notificationConfig(clientRegistrationId)).data);
  }, [client, clientRegistrationId, accept]);
  const perform = useCallback(async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (cause) {
      // error-policy:J4 config and key failures stay explicit; a lost secret response requires a deliberate replacement key.
      if (mounted.current) {
        setReady(false);
        setError(
          cause instanceof Error
            ? cause.message
            : "Notification settings could not be updated",
        );
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void perform(reload);
    return () => {
      mounted.current = false;
    };
  }, [perform, reload]);
  const disabled = !ready || busy;
  return (
    <Card
      variant="outlinedPadded"
      stack="default"
      role="region"
      aria-label="Signed billing notifications"
    >
      <h3 className="text-lg font-semibold">Signed billing notifications</h3>
      <p>
        Send subscription change hints to your app server in {environment} mode.
        Verify the signature, then read current subscription state through the
        SDK before changing access.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!config && !error && <p role="status">Loading notification settings…</p>}
      <Button
        size="touch"
        variant="outline"
        disabled={busy}
        onClick={() => void perform(reload)}
      >
        Refresh notification status
      </Button>
      {config && (
        <>
          <p>
            Delivery {config.enabled ? "enabled" : "disabled"} ·{" "}
            {config.pendingCount} pending · {config.failedCount} failed
          </p>
          <p>
            {config.lastDeliveredAt
              ? `Last delivered ${new Date(config.lastDeliveredAt).toLocaleString()}`
              : "No successful deliveries recorded."}
          </p>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const url = new URL(endpoint);
                if (url.protocol !== "https:" || url.username || url.password)
                  throw new Error(
                    "Use an HTTPS endpoint on a registered app origin.",
                  );
                accept(
                  (
                    await client.configureNotifications({
                      clientRegistrationId,
                      expectedRevision: config.revision,
                      endpointUrl: url.href,
                      enabled,
                    })
                  ).data,
                );
                setNotice("Notification settings saved.");
              });
            }}
          >
            <label className="block" htmlFor={`${id}-endpoint`}>
              App server notification endpoint
            </label>
            <Input
              id={`${id}-endpoint`}
              type="url"
              value={endpoint}
              required
              disabled={disabled}
              placeholder="https://app.example/api/billing/notifications"
              onChange={(event) => setEndpoint(event.target.value)}
            />
            <p>
              The endpoint must use an HTTPS origin already registered to this
              app.
            </p>
            <label
              className="flex min-h-11 items-center gap-3"
              htmlFor={`${id}-enabled`}
            >
              <Checkbox
                id={`${id}-enabled`}
                checked={enabled}
                disabled={disabled || !config.keyId}
                onCheckedChange={(value) => setEnabled(value === true)}
              />
              Enable signed notifications
            </label>
            {!config.keyId && (
              <p>
                Save the endpoint, prepare and install a signing key, then
                activate it before enabling delivery.
              </p>
            )}
            <Button size="touch" type="submit" disabled={disabled}>
              Save notification settings
            </Button>
          </form>
          <section className="space-y-3" aria-label="Notification signing keys">
            <h4 className="font-semibold">Signing key</h4>
            <p className="break-all">
              {config.keyId
                ? `Active key: ${config.keyId}`
                : "No active signing key."}
            </p>
            <p>
              Prepare a key, install it in your app server’s secret manager, and
              confirm activation. Keep the previous key accepted for in-flight
              retries.
            </p>
            <Button
              size="touch"
              variant="outline"
              disabled={disabled || config.revision === null}
              onClick={() =>
                void perform(async () => {
                  setSecret(null);
                  setInstalled(false);
                  const result = (
                    await client.prepareNotificationKey({
                      clientRegistrationId,
                      expectedRevision: config.revision,
                    })
                  ).data;
                  if (!result.config.pendingKeyId)
                    throw new Error(
                      "Prepared signing key has no pending identifier",
                    );
                  accept(result.config);
                  if (mounted.current) setSecret(result.signingSecret);
                })
              }
            >
              {config.pendingKeyId
                ? "Replace pending signing key"
                : "Prepare signing key"}
            </Button>
            {secret && (
              <Card
                variant="insetPadded"
                stack="compact"
                role="region"
                aria-label="One-time notification secret"
              >
                <p>
                  This secret is shown once. Store it only on your app server.
                </p>
                <Input
                  aria-label="New notification signing secret"
                  type="password"
                  readOnly
                  value={secret}
                  autoComplete="off"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="touch"
                    onClick={() =>
                      void perform(async () => {
                        await navigator.clipboard.writeText(secret);
                        setNotice("Signing secret copied.");
                      })
                    }
                  >
                    Copy signing secret
                  </Button>
                  <Button
                    size="touch"
                    variant="outline"
                    onClick={() => setSecret(null)}
                  >
                    Hide signing secret
                  </Button>
                </div>
              </Card>
            )}
            {config.pendingKeyId && (
              <Card variant="insetPadded" stack="compact">
                <p className="break-all">Pending key: {config.pendingKeyId}</p>
                <p>
                  If you lost the one-time secret, prepare a replacement before
                  activating.
                </p>
                <label
                  className="flex min-h-11 items-center gap-3"
                  htmlFor={`${id}-installed`}
                >
                  <Checkbox
                    id={`${id}-installed`}
                    disabled={disabled}
                    checked={installed}
                    onCheckedChange={(value) => setInstalled(value === true)}
                  />
                  I installed this pending key on my app server
                </label>
                <Button
                  size="touch"
                  disabled={disabled || !installed}
                  onClick={() =>
                    void perform(async () => {
                      if (!config.pendingKeyId)
                        throw new Error(
                          "Prepare a signing key before activation",
                        );
                      accept(
                        (
                          await client.activateNotificationKey({
                            clientRegistrationId,
                            expectedRevision: config.revision,
                            pendingKeyId: config.pendingKeyId,
                          })
                        ).data,
                      );
                      setSecret(null);
                      setInstalled(false);
                      setNotice("Signing key activated.");
                    })
                  }
                >
                  Activate installed signing key
                </Button>
              </Card>
            )}
          </section>
        </>
      )}
    </Card>
  );
}
