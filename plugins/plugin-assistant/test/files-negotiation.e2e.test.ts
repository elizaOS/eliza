import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, test } from "vitest";
import {
  deviceRequestCredential,
  handleDeviceActionRoutes,
} from "../../../packages/agent/src/api/device-action-routes.ts";
import { createMachineSession } from "../../../packages/app/src/api/auth/sessions.ts";
import { resolveAuthorizedRouteRole } from "../../../packages/app/src/api/auth.ts";
import {
  AuthStore,
  type DrizzleDatabase,
} from "../../../packages/app/src/services/auth-store.ts";
import { createTestRuntime } from "../../../packages/testing/src/pglite-runtime.ts";
import {
  deviceActionForCapabilities,
  proposeDeviceAction,
} from "../src/services/device-actions/action.ts";
import { FILES_CAPABILITY } from "../src/services/device-actions/files-browser-contract.ts";
import {
  DeviceActionService,
  type DeviceCredential,
} from "../src/services/device-actions/service.ts";
import { withOwnerDeviceActionTurn } from "./device-owner-turn.ts";

type ListedProposal = {
  id: string;
  digest: string;
  state: string;
  execution?: { attemptId: string; dispatchStartedAt: string | null } | null;
};
const prefix = "/api/client-devices";

test("Files capability negotiation preserves review, proposal visibility, and revocation over HTTP", async () => {
  const { runtime, cleanup } = await createTestRuntime({
    characterName: "Files capability fixture",
  });
  const service = new DeviceActionService(runtime);
  const store = new AuthStore(runtime.adapter.db as DrizzleDatabase);
  const subject = randomUUID();
  const installationId = randomUUID();
  const deviceKey = "a".repeat(64);
  const parsed: { credential: DeviceCredential | null } = { credential: null };
  let verifiedGateway = false;
  const server = createServer(async (req, res) => {
    const json = (response: typeof res, value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      const auth = await resolveAuthorizedRouteRole(req, {
        store,
        allowTrustedLocalBypass: false,
        allowCookieAuth: false,
        allowBearerAuth: true,
      });
      const authorization = {
        ...auth,
        role: auth.ok ? auth.role : ("NONE" as const),
        // The verified Cloud gateway owns this field. The test supplies it
        // through the same trusted host parameter, not a request header.
        ...(auth.ok && verifiedGateway
          ? {
              externalIdentity: {
                issuer: "synthetic-test-gateway",
                subject,
                organizationId: "test-organization",
              },
            }
          : {}),
      };
      parsed.credential = deviceRequestCredential(req, authorization);
      await handleDeviceActionRoutes({
        req,
        res,
        pathname: req.url ?? "",
        method: req.method ?? "",
        runtime,
        authorization,
        json,
        error: (response, message, status) =>
          json(response, { error: message }, status),
        readJsonBody: async () => {
          let content = "";
          for await (const chunk of req) content += chunk;
          return JSON.parse(content);
        },
      });
    } catch (error) {
      json(res, { error: String(error) }, 500);
    }
  });
  try {
    await store.createIdentity({
      id: subject,
      kind: "owner",
      displayName: "Synthetic Files owner",
      createdAt: Date.now(),
      passwordHash: null,
    });
    const { session } = await createMachineSession(store, {
      identityId: subject,
      scopes: [],
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert(
      address && typeof address === "object",
      "Expected HTTP test listener",
    );
    const origin = `http://127.0.0.1:${address.port}`;
    const request = async <T>(
      path: string,
      body: Record<string, unknown> | undefined,
      capability: string = FILES_CAPABILITY,
      authorized = true,
    ): Promise<{ status: number; body: T }> => {
      const result = await fetch(origin + prefix + path, {
        method: body ? "POST" : "GET",
        headers: {
          ...(authorized ? { authorization: `Bearer ${session.id}` } : {}),
          "content-type": "application/json",
          "x-eliza-device-id": installationId,
          "x-eliza-device-key": deviceKey,
          ...(capability ? { "x-eliza-device-capabilities": capability } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: result.status, body: (await result.json()) as T };
    };
    const enrollment = await request<{
      installationId: string;
      enrollmentId: string;
      capabilities: string[];
    }>("/register", { label: "Synthetic Files phone" }, "");
    expect(enrollment.status).toBe(200);
    expect(
      enrollment.body.capabilities.filter(
        (value) => value === FILES_CAPABILITY,
      ),
    ).toEqual([FILES_CAPABILITY]);
    expect((await request("/capabilities", undefined, "")).status).toBe(503);
    verifiedGateway = true;
    const cloud = await request<{ deviceActions: { capabilities: string[] } }>(
      "/capabilities",
      undefined,
      "",
    );
    expect(cloud.status).toBe(200);
    expect(
      cloud.body.deviceActions.capabilities.filter(
        (value) => value === FILES_CAPABILITY,
      ),
    ).toEqual([FILES_CAPABILITY]);
    verifiedGateway = false;

    expect(
      (await request("/proposals", undefined, FILES_CAPABILITY, false)).status,
    ).toBe(401);
    expect(
      (
        await request(
          "/proposals",
          undefined,
          `${FILES_CAPABILITY},${FILES_CAPABILITY}`,
        )
      ).status,
    ).toBe(401);
    expect(
      (await request("/proposals", undefined, "files.unknown.v1")).status,
    ).toBe(401);
    const verified = await request<typeof enrollment.body>("/register", {
      label: "Synthetic Files phone",
    });
    expect(verified.status).toBe(200);
    expect(verified.body.enrollmentId).toBe(enrollment.body.enrollmentId);
    const credential = parsed.credential;
    assert(credential, "Expected the production parser to admit Files");
    expect(credential.capabilities).toEqual([FILES_CAPABILITY]);

    const hasFilesMove = (caps: string[]) =>
      JSON.stringify(
        deviceActionForCapabilities(proposeDeviceAction, caps).parameters,
      ).includes('"files_move"');
    expect(hasFilesMove([])).toBe(false);
    expect(hasFilesMove(credential.capabilities ?? [])).toBe(true);
    const operation = {
      type: "files_move",
      paths: ["Download/example.pdf"],
      dest: "Documents",
    };
    await expect(
      service.propose(
        { ...credential, capabilities: [] },
        operation,
        "move",
        "Move the selected file",
      ),
    ).rejects.toThrow("capability");
    await withOwnerDeviceActionTurn(
      runtime,
      credential,
      async () => {
        expect(hasFilesMove(credential.capabilities ?? [])).toBe(false);
        await expect(
          service.propose(
            credential,
            operation,
            "move",
            "Move the selected file",
          ),
        ).rejects.toThrow("Original foreground request ended");
      },
      { isCurrent: () => false },
    );
    expect(
      (await request<{ proposals: ListedProposal[] }>("/proposals", undefined))
        .body.proposals,
    ).toHaveLength(0);
    await withOwnerDeviceActionTurn(runtime, credential, () =>
      service.propose(credential, operation, "move", "Move the selected file"),
    );
    const legacy = await request<{ proposals: ListedProposal[] }>(
      "/proposals",
      undefined,
      "",
    );
    expect(legacy).toEqual({ status: 200, body: { proposals: [] } });
    const pending = await request<{ proposals: ListedProposal[] }>(
      "/proposals",
      undefined,
    );
    expect(pending.status).toBe(200);
    expect(pending.body.proposals).toHaveLength(1);
    const [proposal] = pending.body.proposals;
    expect(proposal).toMatchObject({
      state: "pending",
      execution: null,
      payload: { operation },
    });
    const path = `/proposals/${proposal.id}`;
    const { digest } = proposal;

    expect((await request(path + "/claim", { digest })).status).toBe(409);
    expect(
      (await request(path + "/decision", { digest, decision: "approve" }, ""))
        .status,
    ).toBe(409);
    const reviewed = await request<{ proposal: ListedProposal }>(
      path + "/decision",
      { digest, decision: "approve" },
    );
    expect(reviewed.body.proposal.state).toBe("approved");
    expect((await request(path + "/claim", { digest }, "")).status).toBe(409);
    const claimed = await request<{ proposal: ListedProposal }>(
      path + "/claim",
      { digest },
    );
    expect(claimed.status).toBe(200);
    assert(
      claimed.body.proposal.execution,
      "Expected an owned execution claim",
    );
    expect(claimed.body.proposal.execution.dispatchStartedAt).toBeTruthy();
    const receipt = {
      digest,
      attemptId: claimed.body.proposal.execution.attemptId,
      receipt: { outcome: "applied", operationId: "synthetic-files-move" },
    };
    expect((await request(path + "/receipt", receipt, "")).status).toBe(409);
    expect(
      (await request<{ proposal: ListedProposal }>(path + "/receipt", receipt))
        .body.proposal.state,
    ).toBe("done");
    expect((await request(path + "/claim", { digest })).status).toBe(409);

    expect((await request("/revoke", {})).status).toBe(200);
    expect((await request("/proposals", undefined)).status).toBe(409);
    expect(
      (await request("/register", { label: "Same retired installation" }))
        .status,
    ).toBe(409);
  } finally {
    try {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    } finally {
      await cleanup();
    }
  }
});
