import { useEffect, useRef, useState } from "react";
import type { AuthStatusState } from "../hooks/useAuthStatus.js";
import type { AppRuntimeSessionState } from "./runtime-session.js";

interface RuntimeSessionReadback {
  readonly active: boolean;
  readonly authority: string;
  readonly apiBase: string;
  readonly auth: AuthStatusState;
  /** The existing authenticated API client; no lifecycle or credential mutation. */
  readAgents(signal: AbortSignal): Promise<unknown>;
  currentAuth(): AuthStatusState;
  currentAuthority(): string;
  verifyAuth(): Promise<AuthStatusState>;
}
const inactive = Object.freeze({ status: "inactive" as const });
const verifying = Object.freeze({ status: "verifying" as const });
const unavailable = Object.freeze({
  status: "unavailable" as const,
  message: "The runtime did not verify this owner session.",
});
function ownerKey(auth: AuthStatusState): string | null {
  return auth.phase === "authenticated" &&
    auth.identity.kind === "owner" &&
    auth.access.role === "OWNER" &&
    (auth.access.mode === "local" || auth.access.mode === "session")
    ? JSON.stringify([
        auth.identity.id,
        auth.session.id,
        auth.session.kind,
        auth.access.mode,
      ])
    : null;
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    value === "00000000-0000-0000-0000-000000000000"
  )
    throw Error("Invalid runtime identity");
  return value;
}

/**
 * AppProvider's readback only. The existing startup coordinator starts/stops the
 * runtime and useAuthStatus owns auth. This hook cannot start another resident.
 */
export function useRuntimeSessionState(
  input: RuntimeSessionReadback,
): AppRuntimeSessionState {
  const owner = ownerKey(input.auth);
  const eligibleKey =
    input.active && owner
      ? JSON.stringify([input.authority, input.apiBase, owner])
      : null;
  const lifecycle = useRef({ eligibleKey, generation: 0 });
  if (lifecycle.current.eligibleKey !== eligibleKey) {
    lifecycle.current.eligibleKey = eligibleKey;
    lifecycle.current.generation++;
  }
  const key =
    input.active && owner
      ? JSON.stringify([
          input.authority,
          input.apiBase,
          owner,
          lifecycle.current.generation,
        ])
      : null;
  const current = useRef(input);
  current.current = input;
  const [result, setResult] = useState<{
    key: string;
    state: AppRuntimeSessionState;
  } | null>(null);
  useEffect(() => {
    if (!key || !owner) return;
    const controller = new AbortController();
    const captured = current.current;
    const matches = () =>
      !controller.signal.aborted &&
      current.current.active &&
      current.current.authority === captured.authority &&
      current.current.apiBase === captured.apiBase &&
      current.current.currentAuthority() === captured.authority &&
      ownerKey(current.current.currentAuth()) === owner;
    void captured
      .verifyAuth()
      .then((auth) => {
        if (!matches() || ownerKey(auth) !== owner) return null;
        return captured.readAgents(controller.signal);
      })
      .then((value) => {
        if (!matches()) return;
        if (
          !value ||
          typeof value !== "object" ||
          !Array.isArray(Reflect.get(value, "agents"))
        )
          throw Error("Invalid runtime response");
        const agents: unknown[] = Reflect.get(value, "agents");
        if (
          agents.length !== 1 ||
          !agents[0] ||
          typeof agents[0] !== "object" ||
          Reflect.get(agents[0], "status") !== "running"
        )
          throw Error("Runtime is not running");
        const agent = agents[0];
        const auth = captured.auth;
        if (auth.phase !== "authenticated") return;
        setResult({
          key,
          state: Object.freeze({
            status: "verified",
            session: Object.freeze({
              authority: captured.authority,
              apiBase: captured.apiBase,
              ownerId: id(auth.identity.id),
              agentId: id(Reflect.get(agent, "id")),
              sessionId: crypto.randomUUID(),
              agentName:
                typeof Reflect.get(agent, "name") === "string"
                  ? Reflect.get(agent, "name")
                  : "Local agent",
            }),
          }),
        });
      })
      .catch(() => {
        if (matches()) setResult({ key, state: unavailable });
      });
    return () => controller.abort();
  }, [key, owner]);
  if (!input.active) return inactive;
  if (!owner) return input.auth.phase === "loading" ? verifying : unavailable;
  return result?.key === key ? result.state : verifying;
}
