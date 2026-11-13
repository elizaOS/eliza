import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { resolvePhoneCalendarRange } from "@elizaos/contracts";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { expect, test } from "vitest";
import { approvalDispatchControlTable } from "../../plugin-sql/src/schema/approvalDispatchControl";
import { approvalRequestTable } from "../../plugin-sql/src/schema/approvalRequests";
import {
  DeviceActionService,
  deviceProposalDigest,
} from "../src/services/device-actions/service";

async function createTable(pg: PGlite, table: any) {
  const c = getTableConfig(table),
    dialect = new PgDialect(),
    literal = (v: any) =>
      typeof v === "object" && v?.getSQL
        ? dialect.sqlToQuery(v).sql
        : typeof v === "object"
          ? `'${JSON.stringify(v)}'::jsonb`
          : typeof v === "string"
            ? `'${v.replaceAll("'", "''")}'`
            : String(v);
  await pg.exec(
    `CREATE TABLE ${c.name} (${c.columns.map((col) => `"${col.name}" ${col.getSQLType()}${col.notNull ? " NOT NULL" : ""}${col.default !== undefined ? " DEFAULT " + literal(col.default) : ""}${col.primary ? " PRIMARY KEY" : ""}`).join(",")}${c.primaryKeys.length ? ", " + c.primaryKeys.map((k) => `PRIMARY KEY(${k.columns.map((c) => c.name).join(",")})`).join(",") : ""})`,
  );
}
test("canonical workflow proposes only to its enrolled paired subject and refuses changed authority", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(
      "CREATE TABLE client_devices(agent_id uuid,subject_user_id text,installation_id text,enrollment_id uuid,key_hash text,label text,workflow_protocol integer NOT NULL DEFAULT 0, view_profile text,workflow_owner_id text,revoked boolean NOT NULL DEFAULT false,PRIMARY KEY(agent_id,subject_user_id,installation_id));",
    );
    await createTable(pg, approvalRequestTable);
    await createTable(pg, approvalDispatchControlTable);
    await pg.exec(
      "CREATE UNIQUE INDEX approvals_unique ON approval_requests(agent_id,idempotency_key) WHERE idempotency_key IS NOT NULL; CREATE SCHEMA workflow; CREATE TABLE workflow.embedded_executions(agent_id uuid,id text,workflow_id text,execution jsonb); CREATE TABLE workflow.embedded_workflows(agent_id uuid,id text,version_id text,workflow jsonb); CREATE TABLE workflow.workflow_revisions(agent_id uuid,workflow_id text,version_id text,workflow jsonb);",
    );
    const agentId = randomUUID(),
      runtime = {
        agentId,
        adapter: { db: drizzle(pg) },
        getService: () => null,
      } as any,
      service = new DeviceActionService(runtime),
      owner = randomUUID(),
      subject = randomUUID(),
      credential = {
        subjectUserId: subject,
        installationId: randomUUID(),
        deviceKey: "b".repeat(64),
      },
      enrollment = await service.register(
        credential,
        "Synthetic device",
        1,
        owner,
      ),
      target = {
        installationId: enrollment.installationId,
        enrollmentId: enrollment.enrollmentId,
      },
      workflowId = randomUUID(),
      versionId = randomUUID(),
      runId = randomUUID(),
      spec = {
        version: 1,
        device: target,
        steps: [
          {
            id: "save",
            kind: "Write",
            operation: "save_note",
            title: "Synthetic note",
          },
        ],
      },
      binding = {
        workflowId,
        versionId,
        runId,
        stepId: "save",
        specDigest: createHash("sha256")
          .update(JSON.stringify(spec))
          .digest("hex"),
      },
      dispatch = {
        target,
        binding,
        operation: {
          type: "create_note",
          title: "Synthetic note",
          body: "Synthetic text",
        },
      } as any;
    await pg.query(
      "INSERT INTO workflow.embedded_executions VALUES($1,$2,$3,$4)",
      [
        agentId,
        runId,
        workflowId,
        JSON.stringify({
          workflowVersionId: versionId,
          status: "running",
          finished: false,
        }),
      ],
    );
    await pg.query(
      "INSERT INTO workflow.embedded_workflows VALUES($1,$2,$3,$4)",
      [
        agentId,
        workflowId,
        versionId,
        JSON.stringify({
          name: "Synthetic workflow",
          metadata: {
            elizaOwnerEntityId: owner,
            elizaPhoneWorkflowSpec: JSON.stringify(spec),
          },
        }),
      ],
    );
    const proposal = await service.proposeForWorkflow(owner, dispatch);
    expect(proposal.subjectUserId).toBe(subject);
    expect(proposal.state).toBe("pending");
    expect((await service.proposeForWorkflow(owner, dispatch)).id).toBe(
      proposal.id,
    );
    expect((await service.list(credential)).map((p) => p.id)).toEqual([
      proposal.id,
    ]);
    await expect(
      service.proposeForWorkflow(subject, dispatch),
    ).rejects.toThrow();
    await expect(
      service.proposeForWorkflow(randomUUID(), dispatch),
    ).rejects.toThrow();
    await expect(
      service.proposeForWorkflow(owner, {
        ...dispatch,
        target: { ...target, enrollmentId: randomUUID() },
      }),
    ).rejects.toThrow();
    // A trusted phone refusal settles the real durable claim without a result.
    // The coordinator suite separately proves that only its typed refusal emits this code.
    const proposalDigest = deviceProposalDigest(proposal);
    await service.decide(credential, proposal.id, proposalDigest, true);
    const claimed = await service.claim(
      credential,
      proposal.id,
      proposalDigest,
    );
    const refusal = {
      outcome: "failed",
      code: "DEVICE_NOT_DISPATCHED",
      operationId: randomUUID(),
    };
    const refused = await service.receipt(
      credential,
      proposal.id,
      proposalDigest,
      claimed.execution!.attemptId,
      refusal,
    );
    expect(refused.state).toBe("done");
    expect(refused.execution?.providerReceipt).toMatchObject(refusal);
    expect(
      (
        await service.receipt(
          credential,
          proposal.id,
          proposalDigest,
          claimed.execution!.attemptId,
          refusal,
        )
      ).execution?.attemptId,
    ).toBe(claimed.execution!.attemptId);
    await expect(
      service.claim(credential, proposal.id, proposalDigest),
    ).rejects.toThrow();
    await expect(
      service.receipt(
        credential,
        proposal.id,
        proposalDigest,
        claimed.execution!.attemptId,
        { outcome: "unknown", operationId: refusal.operationId },
      ),
    ).rejects.toThrow();
    const range = {
      calendarIds: ["selected-calendar"],
      days: 1,
      timeZone: "America/Los_Angeles",
      maximumEvents: 10,
    };
    const calendarSpec = {
      ...spec,
      steps: [
        { id: "agenda", kind: "Read", operation: "calendar_range", range },
        {
          id: "later-agenda",
          kind: "Read",
          operation: "calendar_range",
          range,
        },
      ],
    };
    await pg.query(
      "UPDATE workflow.embedded_workflows SET workflow=$1 WHERE id=$2",
      [
        JSON.stringify({
          metadata: {
            elizaOwnerEntityId: owner,
            elizaPhoneWorkflowSpec: JSON.stringify(calendarSpec),
          },
        }),
        workflowId,
      ],
    );
    const calendarDispatch = {
      target,
      binding: {
        ...binding,
        stepId: "agenda",
        specDigest: createHash("sha256")
          .update(JSON.stringify(calendarSpec))
          .digest("hex"),
      },
      operation: {
        type: "read_calendar_range",
        ...range,
      },
    } as const;
    // A legacy run without a saved proposal cannot invent a range on restart.
    await service.register(credential, "Synthetic device", 4, owner);
    await expect(
      service.proposeForWorkflow(owner, calendarDispatch),
    ).rejects.toThrow("Workflow Calendar run time unavailable");
    const anchor = "2026-11-01T06:55:00.000Z";
    await pg.query(
      "UPDATE workflow.embedded_executions SET execution=execution || $1::jsonb WHERE id=$2",
      [
        JSON.stringify({
          calendarAnchorAt: anchor,
          mode: "trigger",
          input: { typedSchedule: { status: "ready", scheduledAt: anchor } },
        }),
        runId,
      ],
    );
    // Older peers can read absolute windows, but cannot review an anchored relative range.
    await service.register(credential, "Synthetic device", 3, owner);
    await expect(
      service.proposeForWorkflow(owner, calendarDispatch),
    ).rejects.toThrow();
    expect(
      (await pg.query("SELECT id FROM approval_requests")).rows,
    ).toHaveLength(1);
    await service.register(credential, "Synthetic device", 4, owner);
    await expect(
      service.proposeForWorkflow(owner, calendarDispatch),
    ).rejects.toThrow();
    await service.register(credential, "Synthetic device", 5, owner);
    const calendarProposal = await service.proposeForWorkflow(
      owner,
      calendarDispatch,
    );
    expect(calendarProposal.state).toBe("pending");
    const absolute = {
      type: "read_calendar_range",
      ...resolvePhoneCalendarRange(range, Date.parse(anchor)),
    } as const;
    expect(absolute.start).toBe("2026-10-31T07:00:00.000Z");
    expect(absolute.end).toBe("2026-11-01T07:00:00.000Z");
    expect(calendarProposal.payload).toMatchObject({ operation: absolute });
    expect(
      (
        await new DeviceActionService(runtime).proposeForWorkflow(
          owner,
          calendarDispatch,
        )
      ).id,
    ).toBe(calendarProposal.id);
    const later = await service.proposeForWorkflow(owner, {
      ...calendarDispatch,
      binding: { ...calendarDispatch.binding, stepId: "later-agenda" },
    });
    expect(later.payload).toMatchObject({ operation: absolute });
    for (const operation of [
      { ...calendarDispatch.operation, calendarIds: ["other-calendar"] },
      { ...calendarDispatch.operation, maximumEvents: 200 },
      {
        ...absolute,
        ...resolvePhoneCalendarRange(
          range,
          Date.parse("2026-11-01T07:02:00.000Z"),
        ),
      },
    ]) {
      await expect(
        service.proposeForWorkflow(owner, { ...calendarDispatch, operation }),
      ).rejects.toThrow();
    }
    await service.register(credential, "Synthetic device", 4, owner);
    await expect(
      service.proposeForWorkflow(owner, calendarDispatch),
    ).rejects.toThrow();
    const calendarDigest = deviceProposalDigest(calendarProposal);
    await expect(
      service.decide(credential, calendarProposal.id, calendarDigest, true),
    ).rejects.toThrow();
    await service.register(credential, "Synthetic device", 5, owner);
    await service.decide(credential, calendarProposal.id, calendarDigest, true);
    await service.register(credential, "Synthetic device", 4, owner);
    await expect(
      service.claim(credential, calendarProposal.id, calendarDigest),
    ).rejects.toThrow();
    // A proposal enqueued before the anchor field existed retains its original
    // absolute payload, identity and expiry after the service is recreated.
    await pg.query(
      "UPDATE workflow.embedded_executions SET execution=execution - 'calendarAnchorAt' WHERE id=$1",
      [runId],
    );
    const legacy = await new DeviceActionService(runtime).proposeForWorkflow(
      owner,
      calendarDispatch,
    );
    expect(legacy.id).toBe(calendarProposal.id);
    expect(deviceProposalDigest(legacy)).toBe(calendarDigest);
    expect(legacy.expiresAt).toEqual(calendarProposal.expiresAt);
    await pg.query(
      'UPDATE workflow.embedded_executions SET execution=execution || \'{"finished":true,"status":"cancelled"}\'::jsonb',
    );
    await expect(service.proposeForWorkflow(owner, dispatch)).rejects.toThrow();
    expect(
      (await pg.query("SELECT id FROM approval_requests")).rows,
    ).toHaveLength(3);
  } finally {
    await pg.close();
  }
}, 120000);
