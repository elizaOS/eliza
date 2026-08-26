/**
 * Play-safe Android account-lifecycle transport for the canonical app shell.
 *
 * Ordinary account authentication stays owned by the hosted PKCE flow. This
 * module adds only the deletion capability protocol: it keeps admission,
 * status, and recovery authority in Android Keystore-backed slots and uses
 * CapacitorHttp so a WebView navigation never receives those secrets.
 */

import { CapacitorHttp, registerPlugin } from "@capacitor/core";
import { getCloudAuthToken } from "../api/client-cloud";
import {
  DEFAULT_DIRECT_CLOUD_API_BASE_URL,
  directCloudAppBaseForApi,
  resolveCanonicalDirectCloudApiBase,
} from "../api/direct-cloud-endpoints";
import type { AndroidCloudAccountLifecycleAdapter } from "./AndroidCloudSettings";
import {
  type AccountDeletionRequestDto,
  parseAccountDeletionAccepted,
  parseAccountDeletionAvailability,
  parseAccountDeletionEnvelope,
  parseAccountDeletionRequest,
} from "./account-deletion-contract";

type SecureCredentialSlot =
  | "account_deletion_admission"
  | "account_deletion_status"
  | "account_deletion_recovery";

interface SecureCredentialsPlugin {
  get(options: {
    slot: SecureCredentialSlot;
  }): Promise<{ value: string | null }>;
  set(options: { slot: SecureCredentialSlot; value: string }): Promise<void>;
  remove(options: { slot: SecureCredentialSlot }): Promise<void>;
}

interface PlayExportPlugin {
  saveExport(options: {
    apiBase: string;
    appOrigin: string;
    recoveryCredential: string;
  }): Promise<{ saved: boolean; contentDigest?: string }>;
}

interface PlaySettingsPlugin {
  openAppSettings(): Promise<void>;
}

interface NativeHttpResponse {
  status: number;
  data: unknown;
}

interface NativeHttpOptions {
  url: string;
  method: "GET" | "POST" | "DELETE";
  headers: Record<string, string>;
  data?: Record<string, unknown>;
  disableRedirects: boolean;
}

export interface AndroidCloudAccountLifecycleOptions {
  apiBase?: string;
  appBase?: string;
  secureCredentials?: SecureCredentialsPlugin;
  playExport?: PlayExportPlugin;
  readAuthToken?: () => string | null;
  request?: (options: NativeHttpOptions) => Promise<NativeHttpResponse>;
  randomBytes?: (size: number) => Uint8Array;
}

const SecureCredentials = registerPlugin<SecureCredentialsPlugin>(
  "ElizaSecureCredentials",
);
const PlayExport = registerPlugin<PlayExportPlugin>("ElizaPlayExport");
const PlaySettings = registerPlugin<PlaySettingsPlugin>("ElizaPlaySettings");

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class AndroidCloudLifecycleError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AndroidCloudLifecycleError";
  }
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // error-policy:J3 Non-JSON provider errors are translated below.
    }
  }
  return {};
}

function randomCapability(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(32);
  if (bytes.byteLength !== 32) {
    throw new AndroidCloudLifecycleError(
      "This device could not create secure account deletion recovery access.",
      "ADMISSION_CREDENTIAL_INVALID",
    );
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const credential = globalThis
    .btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  if (!CAPABILITY_PATTERN.test(credential)) {
    throw new AndroidCloudLifecycleError(
      "This device could not create secure account deletion recovery access.",
      "ADMISSION_CREDENTIAL_INVALID",
    );
  }
  return credential;
}

/** Build one isolated lifecycle client; exported so failure races stay testable. */
export function createAndroidCloudAccountLifecycle(
  options: AndroidCloudAccountLifecycleOptions = {},
): AndroidCloudAccountLifecycleAdapter {
  const apiBase = resolveCanonicalDirectCloudApiBase(
    options.apiBase ??
      import.meta.env.VITE_ELIZA_CLOUD_BASE ??
      DEFAULT_DIRECT_CLOUD_API_BASE_URL,
  );
  const appBase = options.appBase ?? directCloudAppBaseForApi(apiBase);
  const credentials = options.secureCredentials ?? SecureCredentials;
  const playExport = options.playExport ?? PlayExport;
  const readAuthToken = options.readAuthToken ?? (() => getCloudAuthToken());
  const request =
    options.request ??
    ((input: NativeHttpOptions) => CapacitorHttp.request(input));
  const makeRandomBytes =
    options.randomBytes ??
    ((size: number) => {
      const bytes = new Uint8Array(size);
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    });

  let volatileStatusCredential: string | null = null;
  let volatileRecoveryCredential: string | null = null;
  let mutationTail: Promise<void> = Promise.resolve();
  let deletionRequestInFlight: Promise<AccountDeletionRequestDto> | null = null;

  const store = (slot: SecureCredentialSlot) => ({
    async read(): Promise<string | null> {
      return (await credentials.get({ slot })).value?.trim() || null;
    },
    async write(value: string): Promise<void> {
      await credentials.set({ slot, value });
    },
    async clear(): Promise<void> {
      await credentials.remove({ slot });
    },
  });

  const admissionStore = store("account_deletion_admission");
  const statusStore = store("account_deletion_status");
  const recoveryStore = store("account_deletion_recovery");

  async function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function lifecycleRequest(
    path: string,
    input: {
      method?: "GET" | "POST" | "DELETE";
      authenticated?: boolean;
      data?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Origin: appBase,
      "x-eliza-csrf": "1",
      ...input.headers,
    };
    if (input.data !== undefined) headers["Content-Type"] = "application/json";
    if (input.authenticated) {
      const token = readAuthToken()?.trim();
      if (!token) {
        throw new AndroidCloudLifecycleError(
          "Sign in again before changing account deletion settings.",
          "RECENT_AUTH_REQUIRED",
        );
      }
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await request({
      url: `${apiBase}${path}`,
      method: input.method ?? "GET",
      headers,
      data: input.data,
      disableRedirects: true,
    });
    const body = responseRecord(response.data);
    if (response.status < 200 || response.status >= 300) {
      const message =
        (typeof body.error === "string" && body.error) ||
        (typeof body.message === "string" && body.message) ||
        `Account deletion request failed (${response.status}).`;
      const code =
        typeof body.code === "string" && body.code
          ? body.code
          : `HTTP_${response.status}`;
      throw new AndroidCloudLifecycleError(message, code, response.status);
    }
    return body;
  }

  async function invalidateStatusIfCurrent(expected: string): Promise<boolean> {
    return serialize(async () => {
      let persisted: string | null;
      try {
        persisted = await statusStore.read();
      } catch {
        return false;
      }
      if ((persisted ?? volatileStatusCredential) !== expected) return false;
      await statusStore.clear();
      if (volatileStatusCredential === expected)
        volatileStatusCredential = null;
      return true;
    });
  }

  async function publicStatus(): Promise<AccountDeletionRequestDto | null> {
    let credential: string | null;
    try {
      credential = (await statusStore.read()) ?? volatileStatusCredential;
    } catch (error) {
      if (!volatileStatusCredential) throw error;
      credential = volatileStatusCredential;
    }
    if (!credential) return null;
    try {
      return parseAccountDeletionEnvelope(
        await lifecycleRequest("/api/public/account-deletion", {
          headers: { "X-Account-Deletion-Status": credential },
        }),
      );
    } catch (error) {
      if (error instanceof AndroidCloudLifecycleError && error.status === 401) {
        await invalidateStatusIfCurrent(credential);
        return null;
      }
      // A route/deploy 404 is an outage, not proof that capability authority
      // vanished. Recovery authority is never cleared by a status GET.
      throw error;
    }
  }

  async function persistCapabilities(input: {
    statusCredential: string;
    recoveryCredential: string;
  }): Promise<void> {
    await serialize(async () => {
      volatileStatusCredential = input.statusCredential;
      volatileRecoveryCredential = input.recoveryCredential;
      try {
        await statusStore.write(input.statusCredential);
        await recoveryStore.write(input.recoveryCredential);
        const [status, recovery] = await Promise.all([
          statusStore.read(),
          recoveryStore.read(),
        ]);
        if (
          status !== input.statusCredential ||
          recovery !== input.recoveryCredential
        ) {
          throw new Error("secure capability read-back failed");
        }
      } catch (cause) {
        await Promise.allSettled([statusStore.clear(), recoveryStore.clear()]);
        throw new AndroidCloudLifecycleError(
          "This device could not preserve account recovery access.",
          "RECOVERY_STORAGE_UNAVAILABLE",
          null,
          { cause },
        );
      }
    });
  }

  async function admissionCredential(): Promise<string> {
    try {
      const existing = await admissionStore.read();
      if (existing) {
        if (CAPABILITY_PATTERN.test(existing)) return existing;
        await admissionStore.clear();
        throw new Error("stored admission credential was malformed");
      }
      const credential = randomCapability(makeRandomBytes);
      await admissionStore.write(credential);
      if ((await admissionStore.read()) !== credential) {
        throw new Error("secure admission credential read-back failed");
      }
      return credential;
    } catch (cause) {
      await Promise.allSettled([admissionStore.clear()]);
      throw new AndroidCloudLifecycleError(
        "This device could not preserve account deletion admission access. No deletion request was sent.",
        "ADMISSION_STORAGE_UNAVAILABLE",
        null,
        { cause },
      );
    }
  }

  async function cancelWith(
    recoveryCredential: string,
  ): Promise<AccountDeletionRequestDto> {
    const body = await lifecycleRequest("/api/public/account-deletion", {
      method: "DELETE",
      headers: { "X-Account-Deletion-Recovery": recoveryCredential },
      data: { confirmation: "CANCEL DELETION" },
    });
    return parseAccountDeletionRequest(body.request);
  }

  async function requestDeletionOnce(): Promise<AccountDeletionRequestDto> {
    const admission = await admissionCredential();
    let body: Record<string, unknown>;
    try {
      body = await lifecycleRequest("/api/v1/me/account-deletion", {
        method: "POST",
        authenticated: true,
        data: { confirmation: "DELETE", admissionCredential: admission },
      });
    } catch (error) {
      const status =
        error instanceof AndroidCloudLifecycleError ? error.status : null;
      const ambiguous =
        status === null ||
        status === 408 ||
        status === 425 ||
        status === 429 ||
        status >= 500;
      if (!ambiguous) await Promise.allSettled([admissionStore.clear()]);
      throw error;
    }
    const accepted = parseAccountDeletionAccepted(body);
    try {
      await persistCapabilities(accepted);
    } catch (storageError) {
      try {
        const canceling = await cancelWith(accepted.recoveryCredential);
        volatileRecoveryCredential = null;
        await Promise.allSettled([admissionStore.clear()]);
        return canceling;
      } catch (rollbackError) {
        throw new AndroidCloudLifecycleError(
          `Deletion receipt ${accepted.request.requestId} was reserved, but this device could not preserve recovery access or verify automatic cancellation. Keep the app open and contact support.`,
          "RECOVERY_STORAGE_AND_ROLLBACK_FAILED",
          null,
          { cause: new AggregateError([storageError, rollbackError]) },
        );
      }
    }
    try {
      await admissionStore.clear();
    } catch (cause) {
      throw new AndroidCloudLifecycleError(
        `Deletion receipt ${accepted.request.requestId} was reserved and recovery access was stored, but this device could not clear its pending admission credential. Retry to finish secure cleanup.`,
        "ADMISSION_CLEANUP_UNAVAILABLE",
        null,
        { cause },
      );
    }
    return accepted.request;
  }

  return {
    async getAvailability() {
      return parseAccountDeletionAvailability(
        await lifecycleRequest("/api/v1/me/account-deletion", {
          authenticated: true,
        }),
      );
    },

    async getStatus() {
      const token = readAuthToken()?.trim();
      if (token) {
        try {
          return parseAccountDeletionEnvelope(
            await lifecycleRequest("/api/v1/me/account-deletion", {
              authenticated: true,
            }),
          );
        } catch (error) {
          if (
            !(error instanceof AndroidCloudLifecycleError) ||
            error.status !== 401
          ) {
            throw error;
          }
        }
      }
      return publicStatus();
    },

    async requestDeletion() {
      if (deletionRequestInFlight) return deletionRequestInFlight;
      const attempt = requestDeletionOnce();
      deletionRequestInFlight = attempt;
      try {
        return await attempt;
      } finally {
        if (deletionRequestInFlight === attempt) {
          deletionRequestInFlight = null;
        }
      }
    },

    async cancelDeletion() {
      let credential: string | null;
      try {
        credential = (await recoveryStore.read()) ?? volatileRecoveryCredential;
      } catch (error) {
        if (!volatileRecoveryCredential) throw error;
        credential = volatileRecoveryCredential;
      }
      if (!credential) {
        throw new AndroidCloudLifecycleError(
          "Recovery access is unavailable on this device.",
          "STATUS_CREDENTIAL_INVALID",
        );
      }
      const requestDto = await cancelWith(credential);
      if (
        requestDto.status === "canceling" ||
        requestDto.status === "canceled"
      ) {
        volatileRecoveryCredential = null;
        try {
          await recoveryStore.clear();
        } catch {
          // The server has already invalidated this recovery capability.
        }
      }
      return requestDto;
    },

    async downloadExport() {
      let credential: string | null;
      try {
        credential = (await recoveryStore.read()) ?? volatileRecoveryCredential;
      } catch (error) {
        if (!volatileRecoveryCredential) throw error;
        credential = volatileRecoveryCredential;
      }
      if (!credential) {
        throw new AndroidCloudLifecycleError(
          "Recovery access is unavailable on this device.",
          "EXPORT_CREDENTIAL_INVALID",
        );
      }
      return (
        await playExport.saveExport({
          apiBase,
          appOrigin: appBase,
          recoveryCredential: credential,
        })
      ).saved;
    },
  };
}

export const androidCloudAccountLifecycle =
  createAndroidCloudAccountLifecycle();

export async function openAndroidAppSettings(): Promise<void> {
  await PlaySettings.openAppSettings();
}
