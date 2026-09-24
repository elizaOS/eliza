/** Owner admission of a registered device browser for the currently selected hosted agent. */
import { useCallback, useEffect, useId, useState } from "react";
import { client } from "../../api";
import type { RemoteHostSummary } from "../../api/remote-control-cloud-client";
import {
  createDefaultRemoteControlCloudClient,
  getDefaultRemoteControlCloudConnection,
} from "../../api/remote-control-cloud-default";
import { getActiveAgentAuthority } from "../../hooks/useActiveAgentAuthority";
import {
  getLocalBrowserProfile,
  getRemoteTargetIdentity,
  supportsNativeRemoteTarget,
} from "../../platform/remote-target";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface Status {
  configured: boolean;
  active?: boolean;
  deviceId?: string;
  profileId?: string;
  sessionId?: string;
  preferred?: boolean;
}
interface Pairing {
  code: string;
  sessionId: string;
  profileId: string;
  deviceId: string;
  controller?: { displayName: string; keyId: string };
}
export function RemoteBrowserSearchSettings({
  authority,
}: {
  authority: string;
}): React.JSX.Element {
  const profileInputId = useId();
  const [status, setStatus] = useState<Status | null>(null);
  const [hosts, setHosts] = useState<RemoteHostSummary[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [authorized, setAuthorized] = useState<string | null>(null);
  const authorizationKey =
    status?.sessionId && status.profileId
      ? JSON.stringify([status.sessionId, status.profileId])
      : null;
  const [local, setLocal] = useState<{
    hostId: string;
    profileId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useCallback(
    () => getActiveAgentAuthority() === authority,
    [authority],
  );
  const refresh = useCallback(async () => {
    setError(null);
    const results = await Promise.allSettled([
      client.fetch<Status>("/api/remote-browser/status"),
      Promise.resolve().then(() =>
        createDefaultRemoteControlCloudClient().listHosts(),
      ),
    ]);
    if (!current()) return;
    const [state, directory] = results;
    if (state.status === "fulfilled") setStatus(state.value);
    else setError("This agent’s remote browser settings are unavailable.");
    if (directory.status === "fulfilled")
      setHosts(
        directory.value.hosts.filter((host) => host.status !== "revoked"),
      );
    else
      setError(
        "Sign in to Eliza Cloud to load your registered browser devices.",
      );
  }, [current]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!supportsNativeRemoteTarget()) return;
    // Only public device/profile metadata is read here, always through local IPC.
    void Promise.all([
      getRemoteTargetIdentity(),
      getLocalBrowserProfile(),
    ]).then(
      ([identity, profile]) => {
        if (current() && identity.identity && profile)
          setLocal({ hostId: identity.identity.runtimeId, profileId: profile });
      },
      () => {
        /* error-policy:J4 Optional local prefill is unavailable; explicit device selection remains usable. */
      },
    );
  }, [current]);
  async function mutate(operation: "pair" | "confirm" | "revoke") {
    if (!current()) return;
    setBusy(true);
    setError(null);
    try {
      let body: unknown = {};
      if (operation === "pair") {
        const connection = getDefaultRemoteControlCloudConnection();
        body = {
          apiBaseUrl: connection.baseUrl,
          authToken: connection.authToken,
          deviceId,
          profileId: profileId.trim(),
          preferred: true,
        };
      } else if (operation === "confirm") {
        if (
          !authorizationKey ||
          authorized !== authorizationKey ||
          !status?.sessionId ||
          !status.profileId
        )
          throw new Error("Select the exact profile permission first.");
        body = {
          sessionId: status.sessionId,
          profileId: status.profileId,
          authorizeBrowser: true,
        };
      }
      const result = await client.fetch<Status | Pairing>(
        `/api/remote-browser/${operation}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!current()) return;
      if (operation === "pair") {
        const next = result as Pairing;
        setPairing(next);
        setAuthorized(null);
        setStatus({
          configured: true,
          active: false,
          sessionId: next.sessionId,
          profileId: next.profileId,
          deviceId: next.deviceId,
        });
      } else if (operation === "confirm") {
        setStatus(result as Status);
        setPairing(null);
      } else {
        setStatus({ configured: false });
        setPairing(null);
        setAuthorized(null);
      }
    } catch {
      // error-policy:J4 Never retry device authority mutations or expose token-bearing responses.
      if (current())
        setError(
          operation === "confirm"
            ? "The device has not approved this browser profile or is offline. Approve the code on that device, then try again."
            : "Could not update remote browser access. Check your connection and Cloud sign-in.",
        );
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Remote browser search settings"
      className="rounded-lg border border-border p-4 text-sm"
    >
      <h2 className="font-semibold text-txt">Browser for this agent</h2>
      <p className="mt-2 text-muted">
        Choose one of your registered devices. This agent can search and browse
        in the exact Chromium profile you approve, including its signed-in
        websites.
      </p>
      {status?.active ? (
        <p role="status" className="mt-3 break-all">
          Using profile {status.profileId} on{" "}
          {hosts.find((host) => host.deviceId === status.deviceId)
            ?.displayName ?? status.deviceId}
          .
        </p>
      ) : null}
      {!status?.configured && (
        <div className="mt-3 grid gap-3">
          <label>
            Browser device
            <select
              aria-label="Browser device"
              className="mt-1 min-h-11 w-full rounded border border-border bg-bg p-2"
              value={deviceId}
              disabled={busy}
              onChange={(event) => {
                const id = event.target.value;
                setDeviceId(id);
                const host = hosts.find((item) => item.deviceId === id);
                setProfileId(
                  local && host?.id === local.hostId ? local.profileId : "",
                );
              }}
            >
              <option value="">Choose a registered device</option>
              {hosts.map((host) => (
                <option key={host.deviceId} value={host.deviceId}>
                  {host.displayName} ({host.status})
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={profileInputId}>
            Chromium profile
            <Input
              id={profileInputId}
              aria-label="Chromium profile"
              className="mt-1"
              disabled={busy}
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
              placeholder="Profile shown in Browser settings on that device"
            />
          </label>
          <p className="text-xs text-muted">
            Enroll the device in Settings → Devices & Runtimes first. Its
            Browser settings show the connected profile.
          </p>
          <Button
            variant="accentDarkHover"
            disabled={busy || !status || !deviceId || !profileId.trim()}
            onClick={() => void mutate("pair")}
          >
            Pair this browser
          </Button>
        </div>
      )}
      {status?.configured && !status.active && (
        <div className="mt-3 grid gap-3">
          <p>
            On the selected device, open Devices & Runtimes and approve this
            agent’s pairing code with browser access.
          </p>
          {pairing && (
            <p className="text-lg font-semibold">
              Pairing code: {pairing.code}
            </p>
          )}
          {!pairing && (
            <p className="text-xs text-muted">
              If you no longer have the one-use code, revoke this pending setup
              and pair again.
            </p>
          )}
          <p className="break-all text-xs">Session: {status.sessionId}</p>
          {pairing?.controller && (
            <p className="break-all text-xs">
              Controller: {pairing.controller.displayName} ·{" "}
              {pairing.controller.keyId}
            </p>
          )}
          <label className="flex min-h-11 items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 accent-orange-500"
              checked={Boolean(
                authorizationKey && authorized === authorizationKey,
              )}
              disabled={busy}
              onChange={(event) =>
                setAuthorized(event.target.checked ? authorizationKey : null)
              }
            />
            <span>
              Allow this agent to use profile{" "}
              <code className="break-all">{status.profileId}</code> on the
              selected device.
            </span>
          </label>
          <Button
            variant="accentDarkHover"
            disabled={
              busy || !authorizationKey || authorized !== authorizationKey
            }
            onClick={() => void mutate("confirm")}
          >
            Device approved — connect browser
          </Button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {status?.configured && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void mutate("revoke")}
          >
            Revoke browser access
          </Button>
        )}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh devices
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted">
        If the device is unavailable before search begins, the agent can use its
        configured fallback. A browser action already sent is never replayed on
        another device.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
