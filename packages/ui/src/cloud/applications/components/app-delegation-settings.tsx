/** Lets verified app owners register confidential clients with explicit capabilities and one-time secret disclosure. */
import {
  APP_DELEGATION_SCOPE_LABELS,
  APP_DELEGATION_SCOPES,
  type AppDelegationClientSecret,
  type AppDelegationManagementClient,
  type AppDelegationRegistration,
  type AppDelegationScope,
} from "@elizaos/cloud-sdk/app-delegation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Checkbox } from "../../../components/ui/checkbox";
import { Input } from "../../../components/ui/input";
import { NativeSelect } from "../../../components/ui/native-select";
import { Textarea } from "../../../components/ui/textarea";

export interface AppDelegationSettingsProps {
  client: AppDelegationManagementClient;
  appName: string;
  onChanged?: () => void;
}
export function AppDelegationSettings({
  client,
  appName,
  onChanged,
}: AppDelegationSettingsProps) {
  const [clients, setClients] = useState<AppDelegationRegistration[] | null>(
    null,
  );
  const [environment, setEnvironment] = useState<"test" | "live">("test");
  const [redirects, setRedirects] = useState("");
  const [billingReturnUrl, setBillingReturnUrl] = useState("");
  const [scopes, setScopes] = useState<AppDelegationScope[]>(["identity"]);
  const [secret, setSecret] = useState<AppDelegationClientSecret | null>(null);
  const [confirmation, setConfirmation] = useState<{
    kind: "rotate" | "revoke";
    clientId: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const locked = useRef(false);
  const id = useId();
  const reload = useCallback(async () => {
    const result = await client.list();
    if (active.current) setClients(result.data);
  }, [client]);
  const perform = useCallback(async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (cause) {
      // error-policy:J4 registration and secret failures remain explicit; never fabricate a saved client.
      if (active.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "App clients could not be updated",
        );
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    active.current = true;
    void perform(reload);
    return () => {
      active.current = false;
    };
  }, [perform, reload]);
  const googleIncomplete =
    scopes.some((scope) => scope.startsWith("google.")) &&
    !scopes.includes("google.basic_identity");
  return (
    <Card
      variant="outlinedPadded"
      stack="default"
      role="region"
      aria-label="App client registrations"
    >
      <h2 className="text-xl font-semibold">App connections</h2>
      <p>
        Register {appName}’s backend to use shared sign-in and its own
        subscriptions. Client secrets belong on your server. Your customers can
        use a free Eliza account.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <Button
        size="touch"
        variant="outline"
        disabled={busy}
        onClick={() => void perform(reload)}
      >
        Refresh app clients
      </Button>
      {clients === null ? (
        <p role="status">
          {error
            ? "Client registrations are unavailable."
            : "Loading app clients…"}
        </p>
      ) : clients.length === 0 ? (
        <p>No registered app clients.</p>
      ) : (
        <ul className="space-y-4">
          {clients.map((registration) => (
            <li key={registration.clientId} className="space-y-2">
              <p className="break-all">{registration.clientId}</p>
              <p>
                {registration.billingEnvironment === "live" ? "Live" : "Test"} ·{" "}
                {registration.active
                  ? "Active"
                  : "Revoked or ownership changed"}{" "}
                · Revision {registration.revision}
              </p>
              <p className="break-all">
                Billing return:{" "}
                {registration.billingReturnUrl === null
                  ? "Cloud billing"
                  : registration.billingReturnUrl}
              </p>
              <ul>
                {registration.redirectUris.map((uri) => (
                  <li className="break-all" key={uri}>
                    {uri}
                  </li>
                ))}
              </ul>
              <p>
                {registration.allowedScopes
                  .map((scope) => APP_DELEGATION_SCOPE_LABELS[scope])
                  .join("; ")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="touch"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setConfirmation({
                      kind: "rotate",
                      clientId: registration.clientId,
                    })
                  }
                >
                  Rotate secret for {registration.billingEnvironment} client
                </Button>
                {registration.active && (
                  <Button
                    size="touch"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      setConfirmation({
                        kind: "revoke",
                        clientId: registration.clientId,
                      })
                    }
                  >
                    Revoke {registration.billingEnvironment} client
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {confirmation && (
        <fieldset className="space-y-3">
          <legend className="font-medium">
            {confirmation.kind === "rotate"
              ? "Rotate client secret"
              : "Revoke app client"}
          </legend>
          <p>
            This invalidates the client’s existing user grants. Users must
            consent again. Existing subscriptions remain independent of this
            connection.
          </p>
          <p className="break-all">Client: {confirmation.clientId}</p>
          <Button
            size="touch"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                if (confirmation.kind === "rotate") {
                  const result = await client.rotate(confirmation.clientId);
                  if (active.current) setSecret(result.data);
                } else {
                  await client.revoke(confirmation.clientId);
                  if (active.current) setSecret(null);
                }
                setConfirmation(null);
                await reload();
                onChanged?.();
              })
            }
          >
            Confirm {confirmation.kind === "rotate" ? "rotation" : "revocation"}
          </Button>
          <Button
            size="touch"
            variant="ghost"
            onClick={() => setConfirmation(null)}
          >
            Back
          </Button>
        </fieldset>
      )}
      {secret && (
        <Card
          variant="insetPadded"
          stack="compact"
          role="region"
          aria-label="New client secret"
        >
          <h3 className="font-medium">Save this server secret</h3>
          <p>
            This is the only time this secret is shown. Store it in your app
            backend’s secret manager. Rotating it invalidates the previous
            secret and user grants.
          </p>
          <p className="break-all">
            Client: {secret.clientId} · {secret.billingEnvironment}
          </p>
          <Input
            aria-label="New client secret"
            type="password"
            value={secret.clientSecret}
            readOnly
            autoComplete="off"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="touch"
              onClick={() =>
                void perform(async () => {
                  await navigator.clipboard.writeText(secret.clientSecret);
                  setNotice("Client secret copied");
                })
              }
            >
              Copy client secret
            </Button>
            <Button
              size="touch"
              variant="outline"
              onClick={() => setSecret(null)}
            >
              I saved the secret
            </Button>
          </div>
        </Card>
      )}
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (googleIncomplete) return;
          void perform(async () => {
            const result = await client.register({
              billingEnvironment: environment,
              billingReturnUrl: billingReturnUrl.trim() || null,
              redirectUris: redirects
                .split(/\r?\n/)
                .map((uri) => uri.trim())
                .filter(Boolean),
              allowedScopes: scopes,
            });
            if (active.current) {
              setSecret(result.data);
              setRedirects("");
              setBillingReturnUrl("");
            }
            await reload();
            onChanged?.();
          });
        }}
      >
        <h3 className="text-lg font-medium">Register a client</h3>
        <p>
          Test and live clients are separate. A client’s billing environment
          cannot be changed.
        </p>
        <label htmlFor={`${id}-environment`}>Billing environment</label>
        <NativeSelect
          id={`${id}-environment`}
          value={environment}
          disabled={busy || clients === null}
          onChange={(event) =>
            setEnvironment(event.target.value === "live" ? "live" : "test")
          }
        >
          <option value="test">Test</option>
          <option value="live">Live</option>
        </NativeSelect>
        <label htmlFor={`${id}-billing-return`}>Billing return URL</label>
        <Input
          id={`${id}-billing-return`}
          type="url"
          value={billingReturnUrl}
          onChange={(event) => setBillingReturnUrl(event.target.value)}
          disabled={busy}
        />
        <p>
          Optional HTTPS destination on an allowed app origin after checkout or
          billing portal. Leave empty to return to Cloud billing.
        </p>
        <label htmlFor={`${id}-redirects`}>
          Exact HTTPS return URLs, one per line
        </label>
        <Textarea
          id={`${id}-redirects`}
          value={redirects}
          required
          disabled={busy || clients === null}
          onChange={(event) => setRedirects(event.target.value)}
        />
        <p>Each URL must use an origin already allowed for this app.</p>
        <fieldset className="space-y-3">
          <legend className="font-medium">
            Capabilities customers may consent to
          </legend>
          {APP_DELEGATION_SCOPES.map((scope) => (
            <div key={scope} className="flex items-center gap-3">
              <Checkbox
                id={`${id}-${scope}`}
                checked={scopes.includes(scope)}
                disabled={scope === "identity" || busy || clients === null}
                onCheckedChange={(checked) =>
                  setScopes((previous) =>
                    checked
                      ? [...previous, scope]
                      : previous.filter((value) => value !== scope),
                  )
                }
              />
              <label htmlFor={`${id}-${scope}`}>
                {APP_DELEGATION_SCOPE_LABELS[scope]}
              </label>
            </div>
          ))}
        </fieldset>
        {googleIncomplete && (
          <p role="alert">
            Google capabilities also require explicit Google account identity
            access.
          </p>
        )}
        <Button
          size="touch"
          type="submit"
          disabled={
            busy ||
            clients === null ||
            googleIncomplete ||
            redirects.trim().length === 0
          }
        >
          Register {environment} client
        </Button>
      </form>
    </Card>
  );
}
