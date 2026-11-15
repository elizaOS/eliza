/** Deletion credentials are kept per request, and reading status never activates one. */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
  AccountDeletionClientError,
  abandonAccountDeletion,
  cancelAccountDeletion,
  finishAccountDeletion,
  readAccountDeletionStatuses,
  submitAccountDeletion,
} = await import("../account-deletion-client");

const REQUESTS_KEY = "eliza.account-deletion.requests.v2";
const realFetch = globalThis.fetch;

type Status = "pending_activation" | "reserved" | "canceled";

const PROJECTION: Record<
  Status,
  { accessState: string; canCancel: boolean; nextAction: string }
> = {
  pending_activation: {
    accessState: "active",
    canCancel: false,
    nextAction: "confirm_recovery_package",
  },
  reserved: {
    accessState: "fenced",
    canCancel: true,
    nextAction: "wait_for_export",
  },
  canceled: { accessState: "active", canCancel: false, nextAction: "none" },
};

function credential(prefix: string): string {
  return `${prefix}${"x".repeat(43 - prefix.length)}`;
}

function dto(requestId: string, status: Status) {
  return {
    requestId,
    status,
    requestedAt: "2026-11-01T00:00:00.000Z",
    recoveryExpiresAt: "2026-12-01T00:00:00.000Z",
    scheduledDeletionAt: "2026-12-01T00:00:00.000Z",
    irreversibleAt: null,
    completedAt: null,
    identityDeactivated: status === "reserved",
    ...PROJECTION[status],
    export: null,
  };
}

/** One server-side request: what the fake Cloud answers for its credentials. */
interface FakeRequest {
  requestId: string;
  status: Status;
  statusCredential: string;
  recoveryCredential: string;
  admissionCredential: string | null;
}

interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

let calls: Call[];
let server: FakeRequest[];
let nextRequest: Omit<FakeRequest, "admissionCredential"> | null;
let admissionFailure: { status: number; code: string } | null;
let activationFails: boolean;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function accepted(request: FakeRequest): Response {
  return json(
    {
      request: dto(request.requestId, request.status),
      statusCredential: request.statusCredential,
      recoveryCredential: request.recoveryCredential,
    },
    202,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  calls = [];
  server = [];
  nextRequest = null;
  admissionFailure = null;
  activationFails = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost/").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    calls.push({ method, path, headers, body });
    const admission = body?.admissionCredential;
    const byRecovery = server.find(
      (r) =>
        r.recoveryCredential === headers.get("X-Account-Deletion-Recovery"),
    );

    if (path === "/api/v1/me/account-deletion" && method === "POST") {
      const replay = server.find((r) => r.admissionCredential === admission);
      if (replay) return accepted(replay);
      if (admissionFailure) {
        return json(
          { error: "refused", code: admissionFailure.code },
          admissionFailure.status,
        );
      }
      if (!nextRequest) throw new Error("no request queued");
      const created = {
        ...nextRequest,
        admissionCredential: admission as string,
      };
      nextRequest = null;
      server.push(created);
      return accepted(created);
    }
    if (path === "/api/public/account-deletion") {
      if (method === "POST") {
        const replay = server.find((r) => r.admissionCredential === admission);
        if (replay) return accepted(replay);
        return json(
          { error: "invalid", code: "ADMISSION_CREDENTIAL_INVALID" },
          401,
        );
      }
      if (method === "GET") {
        const found = server.find(
          (r) =>
            r.statusCredential === headers.get("X-Account-Deletion-Status"),
        );
        if (!found) {
          return json(
            { error: "invalid", code: "STATUS_CREDENTIAL_INVALID" },
            401,
          );
        }
        return json({ request: dto(found.requestId, found.status) });
      }
      if (method === "PATCH") {
        if (activationFails) throw new TypeError("network down");
        if (!byRecovery) throw new Error("unknown recovery credential");
        byRecovery.status = "reserved";
        return json({ request: dto(byRecovery.requestId, "reserved") });
      }
      if (method === "DELETE") {
        if (!byRecovery) throw new Error("unknown recovery credential");
        byRecovery.status = "canceled";
        return json({ request: dto(byRecovery.requestId, "canceled") });
      }
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const REQUEST_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_B = "22222222-2222-4222-8222-222222222222";

function queue(requestId: string, tag: string): void {
  nextRequest = {
    requestId,
    status: "pending_activation",
    statusCredential: credential(`s${tag}`),
    recoveryCredential: credential(`r${tag}`),
  };
}

function storedRecord(): {
  requests: Array<Record<string, string | null>>;
} | null {
  const raw = window.localStorage.getItem(REQUESTS_KEY);
  return raw === null ? null : JSON.parse(raw);
}

describe("account deletion credentials", () => {
  it("keeps each account's recovery credential separate", async () => {
    queue(REQUEST_A, "A");
    await submitAccountDeletion({ id: "user-a", label: "a@example.com" });
    queue(REQUEST_B, "B");
    await submitAccountDeletion({ id: "user-b", label: "b@example.com" });

    const listed = await readAccountDeletionStatuses();
    expect(
      listed.map((entry) => [entry.accountLabel, entry.request.requestId]),
    ).toEqual([
      ["a@example.com", REQUEST_A],
      ["b@example.com", REQUEST_B],
    ]);

    calls = [];
    await cancelAccountDeletion(REQUEST_A);
    const cancel = calls.find((call) => call.method === "DELETE");
    expect(cancel?.headers.get("X-Account-Deletion-Recovery")).toBe(
      credential("rA"),
    );
    // B's recovery authority is untouched by A's cancellation.
    const b = storedRecord()?.requests.find((r) => r.requestId === REQUEST_B);
    expect(b?.recoveryCredential).toBe(credential("rB"));
  });

  it("leaves no credential after a rejected deletion request", async () => {
    admissionFailure = { status: 409, code: "identity_unavailable" };
    await expect(
      submitAccountDeletion({ id: "user-a", label: null }),
    ).rejects.toMatchObject({ status: 409 });
    expect(storedRecord()?.requests).toEqual([]);

    calls = [];
    expect(await readAccountDeletionStatuses()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("keeps a saved request's recovery when a retry is rejected", async () => {
    queue(REQUEST_A, "A");
    activationFails = true;
    await submitAccountDeletion({ id: "user-a", label: null }).catch(
      () => undefined,
    );
    // The server no longer replays this admission credential.
    server[0]!.admissionCredential = null;
    admissionFailure = { status: 409, code: "conflict" };
    await expect(
      submitAccountDeletion({ id: "user-a", label: null }),
    ).rejects.toMatchObject({ status: 409 });
    expect(storedRecord()?.requests).toEqual([
      expect.objectContaining({
        requestId: REQUEST_A,
        admissionCredential: null,
        recoveryCredential: credential("rA"),
      }),
    ]);
  });

  it("keeps the admission credential when the request outcome is unknown", async () => {
    admissionFailure = { status: 503, code: "unavailable" };
    await expect(
      submitAccountDeletion({ id: "user-a", label: null }),
    ).rejects.toMatchObject({ status: 503 });
    expect(storedRecord()?.requests[0]?.admissionCredential).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );

    // Recovery then learns nothing was admitted and forgets the credential.
    expect(await readAccountDeletionStatuses()).toEqual([]);
    expect(storedRecord()?.requests).toEqual([]);
  });

  it("never activates a pending request from a status read", async () => {
    queue(REQUEST_A, "A");
    activationFails = true;
    const failure = await submitAccountDeletion({
      id: "user-a",
      label: null,
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AccountDeletionClientError);
    expect(failure).toMatchObject({
      code: "ACCOUNT_DELETION_ACTIVATION_PENDING",
      requestId: REQUEST_A,
    });

    activationFails = false;
    calls = [];
    const listed = await readAccountDeletionStatuses();
    expect(listed.map((entry) => entry.request.status)).toEqual([
      "pending_activation",
    ]);
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    expect(server[0]?.status).toBe("pending_activation");
  });

  it("activates a pending request when the user finishes deletion", async () => {
    queue(REQUEST_A, "A");
    activationFails = true;
    await submitAccountDeletion({ id: "user-a", label: null }).catch(
      () => undefined,
    );
    activationFails = false;

    calls = [];
    const finished = await finishAccountDeletion(REQUEST_A);
    expect(finished.status).toBe("reserved");
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.headers.get("X-Account-Deletion-Recovery")).toBe(
      credential("rA"),
    );
    expect(storedRecord()?.requests[0]?.admissionCredential).toBeNull();
  });

  it("forgets a pending request the user keeps their account from", async () => {
    queue(REQUEST_A, "A");
    activationFails = true;
    await submitAccountDeletion({ id: "user-a", label: null }).catch(
      () => undefined,
    );
    abandonAccountDeletion(REQUEST_A);
    expect(storedRecord()?.requests).toEqual([]);
    expect(server[0]?.status).toBe("pending_activation");
  });

  it("migrates the single v1 keys without losing recovery", async () => {
    server.push({
      requestId: REQUEST_A,
      status: "reserved",
      statusCredential: credential("sA"),
      recoveryCredential: credential("rA"),
      admissionCredential: null,
    });
    window.localStorage.setItem(
      "eliza.account-deletion.status.v1",
      credential("sA"),
    );
    window.localStorage.setItem(
      "eliza.account-deletion.recovery.v1",
      credential("rA"),
    );

    const listed = await readAccountDeletionStatuses();
    expect(listed.map((entry) => entry.request.requestId)).toEqual([
      REQUEST_A,
    ]);
    expect(
      window.localStorage.getItem("eliza.account-deletion.recovery.v1"),
    ).toBeNull();
    expect(storedRecord()?.requests[0]).toMatchObject({
      requestId: REQUEST_A,
      recoveryCredential: credential("rA"),
    });
  });
});
