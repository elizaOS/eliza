/**
 * Renderer permission client: answers camera, microphone, location and
 * notification permissions from the renderer's own Permissions API and falls
 * back to the agent API for everything else.
 */

import type { client as appClient } from "../api/client";
import type {
  PermissionsClientLike as ClientLike,
  PermissionsPatchState as PatchState,
} from "./types";

const PATCH_STATE = Symbol.for("elizaos.desktopPermissionsPatch");
type PatchableClient = ClientLike & { [PATCH_STATE]?: PatchState };

type SystemPermissionId = Parameters<typeof appClient.getPermission>[0];
type PermissionState = Awaited<ReturnType<typeof appClient.getPermission>>;

const RUNTIME_PERMISSION_IDS = ["website-blocking"] as const;
const RENDERER_PERMISSION_IDS = [
  "camera",
  "microphone",
  "location",
  "notifications",
] as const;

function isRuntimePermissionId(id: SystemPermissionId): boolean {
  return (RUNTIME_PERMISSION_IDS as readonly string[]).includes(id);
}

export function isRendererPermissionAuthoritative(
  id: SystemPermissionId,
): boolean {
  return (RENDERER_PERMISSION_IDS as readonly string[]).includes(id);
}

function currentRendererPlatform(): PermissionState["platform"] {
  if (typeof navigator !== "undefined") {
    const platform = navigator.platform.toLowerCase();
    if (platform.includes("mac")) return "darwin";
    if (platform.includes("win")) return "win32";
  }
  return "linux";
}

function buildRendererPermissionState(
  id: SystemPermissionId,
  status: PermissionState["status"],
  lastRequested?: number,
  platform: PermissionState["platform"] = currentRendererPlatform(),
): PermissionState {
  return {
    id,
    status,
    lastChecked: Date.now(),
    ...(lastRequested ? { lastRequested } : {}),
    canRequest: status === "not-determined",
    platform,
  };
}

function mapRendererPermissionState(
  state:
    | PermissionState["status"]
    | "prompt"
    | NotificationPermission
    | undefined,
): PermissionState["status"] | null {
  if (state === "granted" || state === "denied") return state;
  if (state === "prompt" || state === "default") return "not-determined";
  return null;
}

async function queryRendererPermission(
  id: SystemPermissionId,
): Promise<PermissionState | null> {
  const resolvedPlatform = currentRendererPlatform();
  if (
    !isRendererPermissionAuthoritative(id) ||
    typeof navigator === "undefined"
  ) {
    return null;
  }

  if (id === "notifications" && typeof Notification !== "undefined") {
    const status = mapRendererPermissionState(Notification.permission);
    return status
      ? buildRendererPermissionState(id, status, undefined, resolvedPlatform)
      : null;
  }

  if (!navigator.permissions?.query) {
    return null;
  }

  const name = id === "location" ? "geolocation" : id;
  try {
    const result = await navigator.permissions.query({
      name: name as PermissionName,
    });
    const status = mapRendererPermissionState(result.state);
    return status
      ? buildRendererPermissionState(id, status, undefined, resolvedPlatform)
      : null;
  } catch {
    // error-policy:J4 permissions.query unsupported for this name — null is
    // the explicit "state unknown" the permissions UI renders as such.
    return null;
  }
}

async function requestRendererPermission(
  id: SystemPermissionId,
): Promise<PermissionState | null> {
  const resolvedPlatform = currentRendererPlatform();
  if (
    !isRendererPermissionAuthoritative(id) ||
    typeof navigator === "undefined"
  ) {
    return null;
  }

  const lastRequested = Date.now();
  if (id === "camera" || id === "microphone") {
    try {
      const stream = await navigator.mediaDevices?.getUserMedia?.({
        video: id === "camera",
        audio: id === "microphone",
      });
      for (const track of stream?.getTracks?.() ?? []) {
        track.stop();
      }
    } catch {
      // The follow-up query reports denied when the browser has a recorded denial.
    }
    const checked = await queryRendererPermission(id);
    return checked ? { ...checked, lastRequested } : null;
  }

  if (id === "location" && navigator.geolocation) {
    const requestedStatus = await new Promise<PermissionState["status"] | null>(
      (resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => resolve("granted"),
          (err) =>
            resolve(err.code === err.PERMISSION_DENIED ? "denied" : null),
          { maximumAge: 0, timeout: 10_000 },
        );
      },
    );
    const checked = await queryRendererPermission(id);
    if (checked) return { ...checked, lastRequested };
    return requestedStatus
      ? buildRendererPermissionState(
          id,
          requestedStatus,
          lastRequested,
          resolvedPlatform,
        )
      : null;
  }

  if (id === "notifications" && typeof Notification !== "undefined") {
    const status = mapRendererPermissionState(
      await Notification.requestPermission(),
    );
    return status
      ? buildRendererPermissionState(
          id,
          status,
          lastRequested,
          resolvedPlatform,
        )
      : null;
  }

  return queryRendererPermission(id);
}

export function installDesktopPermissionsClientPatch(
  client: ClientLike,
): () => void {
  const patchableClient = client as PatchableClient;
  const existingPatch = patchableClient[PATCH_STATE];
  if (existingPatch) {
    return () => {};
  }

  const originalGetPermission = client.getPermission.bind(client);
  const originalRequestPermission = client.requestPermission.bind(client);

  patchableClient[PATCH_STATE] = {
    getPermission: client.getPermission,
    requestPermission: client.requestPermission,
  } satisfies PatchState;

  client.getPermission = async (id: SystemPermissionId) => {
    if (isRuntimePermissionId(id)) {
      return originalGetPermission(id);
    }
    return (await queryRendererPermission(id)) ?? originalGetPermission(id);
  };

  client.requestPermission = async (id: SystemPermissionId) => {
    if (isRuntimePermissionId(id)) {
      return originalRequestPermission(id);
    }
    return (
      (await requestRendererPermission(id)) ?? originalRequestPermission(id)
    );
  };

  return () => {
    const patchState = patchableClient[PATCH_STATE];
    if (!patchState) {
      return;
    }
    client.getPermission = patchState.getPermission;
    client.requestPermission = patchState.requestPermission;
    delete patchableClient[PATCH_STATE];
  };
}
