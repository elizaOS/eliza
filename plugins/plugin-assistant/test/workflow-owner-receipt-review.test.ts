import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
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
test("paired subject owns review, claim and exact durable receipt after canonical workflow binding", async () => {
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
        getService: () => null,
        adapter: { db: drizzle(pg) },
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
    const digest = deviceProposalDigest(proposal);
    await expect(
      service.claim(credential, proposal.id, digest),
    ).rejects.toThrow();
    await expect(
      service.decide(
        { ...credential, subjectUserId: owner },
        proposal.id,
        digest,
        true,
      ),
    ).rejects.toThrow();
    const approved = await service.decide(
      credential,
      proposal.id,
      digest,
      true,
    );
    expect(approved.resolvedBy).toBe(subject);
    const claimed = await service.claim(credential, proposal.id, digest);
    expect(claimed.execution?.attemptId).toBeTruthy();
    await expect(
      service.claim(credential, proposal.id, digest),
    ).rejects.toThrow();
    const receipt = { outcome: "applied", operationId: randomUUID() },
      attempt = claimed.execution!.attemptId;
    const completed = await service.receipt(
      credential,
      proposal.id,
      digest,
      attempt,
      receipt,
    );
    expect(completed.state).toBe("done");
    expect(
      (await service.receipt(credential, proposal.id, digest, attempt, receipt))
        .id,
    ).toBe(completed.id);
    expect(
      (await service.proposeForWorkflow(owner, dispatch)).execution
        ?.providerReceipt,
    ).toEqual(receipt);
    await expect(
      service.receipt(credential, proposal.id, digest, attempt, {
        ...receipt,
        operationId: randomUUID(),
      }),
    ).rejects.toThrow();
    await pg.query(
      'UPDATE workflow.embedded_executions SET execution=execution || \'{"finished":true,"status":"cancelled"}\'::jsonb',
    );
    await expect(service.proposeForWorkflow(owner, dispatch)).rejects.toThrow();
    expect(
      (await pg.query("SELECT id FROM approval_requests")).rows,
    ).toHaveLength(1);
  } finally {
    await pg.close();
  }
}, 120000);
