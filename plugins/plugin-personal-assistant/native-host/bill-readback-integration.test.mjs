import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createTaskGateway } from "../../../packages/host/native-host/task-runtime-gateway.mjs";
import { deriveBillDecision } from "../test/fixtures/bill-host/policy.mjs";
import { buildTaskRuntime } from "../test/fixtures/bill-host/runtime.mjs";
import { createBillHelperHost } from "./bill-helper-host.mjs";
import { createBillOutcomeStore } from "./bill-outcome-store.mjs";

const reconcileBillMethod = ({ bill, snapshot, record }) => ({
  status:
    record && deriveBillDecision(bill, snapshot).kind === "human-submit"
      ? "succeeded"
      : "unknown",
});

test("controlled bill host resolves only its persisted review through shared read-only reconciliation without replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bill-readback-"));
  const bundle = join(dir, "runtime.mjs");
  buildTaskRuntime(bundle);
  const runtimeModule = await import(pathToFileURL(bundle).href);
  const bill = {
    sourceRef: "mail:bill",
    origin: "https://biller.example",
    company: "Power",
    accountLabel: "Ending 1234",
    amountMinor: 12000,
    currency: "USD",
    currencyDigits: 2,
  };
  let selected = false,
    effects = 0,
    sequence = 0,
    guidanceAvailable = true;
  const bindings = [];
  const text = () =>
    Object.entries({
      Environment: "Controlled test biller",
      Company: "Power",
      Session: "Signed in",
      Verification: "Not required",
      Account: "Ending 1234",
      "Bill amount": "USD 120.00",
      "Payment status": "Unpaid",
      Autopay: "Off",
      "Existing method": "Visa ending 4242",
      Fee: "USD 0.00",
      Total: "USD 120.00",
      "Payment date": "2026-10-03",
      "Method selected": selected ? "Yes" : "No",
    })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  const target = {
    guideTask: async (c) =>
      c.kind === "hide" ? { visible: false } : { accepted: guidanceAvailable },
    bindTask: async (b) => {
      bindings.push(b);
      return {
        bound: true,
        tabId: b.tabId,
        taskId: b.taskId,
        epoch: b.epoch,
        bindingRevision: b.bindingRevision,
      };
    },
    execute: async (c) => {
      if (c.subaction === "click") {
        effects++;
        selected = true;
        return { value: {} };
      }
      assert.equal(c.subaction, "snapshot");
      const id = `view${++sequence}`;
      return {
        value: {
          result: {
            snapshotId: id,
            frames: [
              {
                frameId: 0,
                complete: true,
                documentId: "doc",
                url: bill.origin + "/bill",
                inputRevision: 0,
                text: text(),
                elements: [
                  { selector: `${id}:0:1`, label: "Use existing method" },
                ],
              },
            ],
          },
        },
      };
    },
  };
  const helper = createBillHelperHost({
    deriveBillDecision,
    runtimeModule,
    target,
    credentialGate: async () => "owner",
    authorizeGoal: async () => {},
    billForTask: () => bill,
    policyForTask: () => ({
      tabId: "1",
      origin: bill.origin,
      leaseMs: 10000,
      targets: [{ selector: "#method", action: "click" }],
    }),
    controls: {
      existingMethod: { selector: "#method", label: "Use existing method" },
      signIn: { label: "Sign in" },
      verification: { label: "Verify" },
      submit: { label: "Pay" },
    },
    verify: async () => "unknown",
    recordEvidence: async () => "uncertain",
    reconcileMethod: async (input) => {
      const result = reconcileBillMethod(input);
      if (result.status === "unknown") return result;
      await writeFile(
        join(dir, "evidence.json"),
        JSON.stringify({
          operationId: input.proposal.id,
          status: result.status,
        }),
      );
      return { ...result, evidenceRef: "readback" };
    },
  });
  const dbPath = join(dir, "db");
  let gateway, db;
  try {
    gateway = await createTaskGateway({
      ...helper,
      bundlePath: bundle,
      databasePath: dbPath,
      credentialGate: async () => "owner",
    });
    const runtime = await gateway.forCurrentOwner();
    const task = runtime.create({
      id: "task",
      goalRef: "bill",
      authorization: {
        decisionId: "grant",
        policyRevision: "policy",
        state: "active",
        decidedAt: new Date().toISOString(),
        revokedAt: null,
      },
      allowedCapabilities: ["browser.click"],
      allowedOrigins: [bill.origin],
    });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA synchronous=FULL");
    const outcomes = createBillOutcomeStore(
      db,
      new runtimeModule.SqliteInteractiveTaskStore(db),
    ).forTask(runtime, task.id);
    const workflow = helper.workflowFactory({ runtime, task, outcomes });
    const choice = await workflow.refresh();
    assert.equal(choice.kind, "choose-existing-method");
    assert.equal(
      (
        await workflow.chooseExistingMethod(choice.reviewKey, {
          operationId: "method-operation",
        })
      ).kind,
      "unknown-outcome",
    );
    assert.equal(effects, 1);
    assert.ok(outcomes.loadMethodSelection("method-operation"));
    const before = runtime.get(task.id);
    const reconciled = await helper.reconcileTask({
      runtime,
      task: before,
      outcomes,
      stillAuthorized: () => true,
    });
    assert.equal(reconciled.status, "paused");
    assert.equal(effects, 1);
    assert.deepEqual(bindings.at(-1).targets, []);
    assert.equal(runtime.get(task.id).epoch, before.epoch + 2);
    assert.equal(runtime.get(task.id).operations.length, 1);
    assert.equal(
      outcomes.loadAttempt(),
      null,
      "A verified selection is not a payment attempt",
    );
  } finally {
    db?.close();
    await gateway?.close();
    helper.close();
    await rm(dir, { recursive: true, force: true });
  }
});
