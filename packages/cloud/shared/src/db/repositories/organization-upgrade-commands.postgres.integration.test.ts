/** Real PostgreSQL organization confirmation serialization. Provider mutation is deliberately absent. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  installOrganizationUpgradeTestSchema,
  seedOrganizationUpgradeTestAccount,
} from "./organization-upgrade-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `upgrade_${randomUUID().replaceAll("-", "_")}`;
let db: Client;
let commands: typeof import("./organization-upgrade-commands");
let quotes: typeof import("./organization-upgrade-quotes");
let execution: typeof import("./organization-upgrade-execution");
let close: typeof import("../client").closeDatabaseConnectionsForTests;
async function seed() {
  const f = await seedOrganizationUpgradeTestAccount((text, values) => db.query(text, values));
  const quote = await quotes.saveOrganizationUpgradeQuote({
    identity: f.input,
    captured: f.captured,
    providerBinding: f.providerBinding,
    review: f.review,
  });
  return {
    ...f,
    quote,
    confirm: {
      organizationId: f.input.organizationId,
      actorId: f.input.actorId,
      quoteId: quote.id,
      idempotencyKey: randomUUID(),
    },
  };
}
async function count(organizationId: string) {
  return (
    await db.query(
      "SELECT count(*)::int AS count FROM billing_subscription_commands WHERE organization_id=$1",
      [organizationId],
    )
  ).rows[0].count;
}
(url ? describe : describe.skip)("organization upgrade confirmation PostgreSQL authority", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await installOrganizationUpgradeTestSchema((q) => db.query(q));
    const target = new URL(url!);
    target.searchParams.set("options", `-c search_path=${schema},public`);
    target.searchParams.set("application_name", schema);
    process.env.DATABASE_URL = target.toString();
    process.env.TEST_DATABASE_URL = target.toString();
    process.env.ENVIRONMENT = "local";
    process.env.LOCAL_PG_POOL_MAX = "4";
    commands = await import("./organization-upgrade-commands");
    quotes = await import("./organization-upgrade-quotes");
    execution = await import("./organization-upgrade-execution");
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
  }, 120000);
  afterAll(async () => {
    if (!db) return;
    await close?.();
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  });
  test("concurrent confirmations with different retry keys admit one original command", async () => {
    const f = await seed();
    const results = await Promise.all([
      commands.prepareOrganizationUpgrade(f.confirm),
      commands.prepareOrganizationUpgrade({ ...f.confirm, idempotencyKey: randomUUID() }),
    ]);
    expect(results.filter((x) => x.created)).toHaveLength(1);
    expect(new Set(results.map((x) => x.command.id)).size).toBe(1);
    expect(results[0]!.command.status).toBe("PREPARED");
    expect(results[0]!.command.provider_started_at).toBeNull();
    expect(await count(f.input.organizationId)).toBe(1);
    const quote = await db.query(
      "SELECT consumed_by_command_id FROM organization_plan_change_quotes WHERE id=$1",
      [f.quote.id],
    );
    expect(quote.rows[0].consumed_by_command_id).toBe(results[0]!.command.id);
  });
  test("same idempotency key cannot switch the reviewed quote; competing intent is also blocked", async () => {
    const f = await seed();
    const second = await quotes.saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      providerBinding: f.providerBinding,
      review: f.review,
    });
    await commands.prepareOrganizationUpgrade(f.confirm);
    await expect(
      commands.prepareOrganizationUpgrade({ ...f.confirm, quoteId: second.id }),
    ).rejects.toThrow();
    await expect(
      commands.prepareOrganizationUpgrade({
        ...f.confirm,
        quoteId: second.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(await count(f.input.organizationId)).toBe(1);
  });
  test("another actor or organization cannot consume or replay a quote", async () => {
    const f = await seed(),
      other = await seed();
    await expect(
      commands.prepareOrganizationUpgrade({ ...other.confirm, quoteId: f.quote.id }),
    ).rejects.toThrow();
    await commands.prepareOrganizationUpgrade(f.confirm);
    await expect(
      commands.prepareOrganizationUpgrade({ ...f.confirm, actorId: other.input.actorId }),
    ).rejects.toThrow();
    expect(await count(other.input.organizationId)).toBe(0);
  });
  test("a different current administrator cannot take over the original actor's quote", async () => {
    const f = await seed();
    const administrator = randomUUID();
    await db.query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'admin')", [
      administrator,
      f.input.organizationId,
    ]);
    await expect(
      commands.prepareOrganizationUpgrade({ ...f.confirm, actorId: administrator }),
    ).rejects.toThrow();
    const original = await commands.prepareOrganizationUpgrade(f.confirm);
    await expect(
      commands.prepareOrganizationUpgrade({
        ...f.confirm,
        actorId: administrator,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
    expect((await commands.prepareOrganizationUpgrade(f.confirm)).command.id).toBe(
      original.command.id,
    );
    expect(await count(f.input.organizationId)).toBe(1);
  });
  test("retry after review expiry returns the original command without new admission", async () => {
    const f = await seed();
    const expiresAt = new Date(Date.now() + 2000);
    const quote = await quotes.saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      providerBinding: f.providerBinding,
      review: { ...f.review, expiresAt: expiresAt.toISOString() },
    });
    const input = { ...f.confirm, quoteId: quote.id };
    const original = await commands.prepareOrganizationUpgrade(input);
    await Bun.sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 50);
    const replay = await commands.prepareOrganizationUpgrade({
      ...input,
      idempotencyKey: randomUUID(),
    });
    expect(replay.created).toBe(false);
    expect(replay.command.id).toBe(original.command.id);
    expect(replay.command.provider_started_at).toBeNull();
    expect(await count(f.input.organizationId)).toBe(1);
  });
  test("quote-link persistence failure rolls back the command insert", async () => {
    const f = await seed();
    await db.query(
      `CREATE FUNCTION reject_fixture_quote_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.quote.id}'::uuid AND NEW.consumed_by_command_id IS NOT NULL THEN RAISE EXCEPTION 'fixture storage failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_fixture_quote_link BEFORE UPDATE ON organization_plan_change_quotes FOR EACH ROW EXECUTE FUNCTION reject_fixture_quote_link();`,
    );
    try {
      await expect(commands.prepareOrganizationUpgrade(f.confirm)).rejects.toThrow();
      expect(await count(f.input.organizationId)).toBe(0);
      expect(
        (await quotes.readOrganizationUpgradeQuote(f.input, f.quote.id)).consumed_by_command_id,
      ).toBeNull();
    } finally {
      await db.query(
        "DROP TRIGGER reject_fixture_quote_link ON organization_plan_change_quotes; DROP FUNCTION reject_fixture_quote_link()",
      );
    }
  });
  test("actor revocation while waiting for organization authority blocks confirmation", async () => {
    const f = await seed();
    const holder = new Client({ connectionString: url });
    await holder.connect();
    await holder.query(`SET search_path TO ${schema},public`);
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
        f.input.organizationId,
      ]);
      pending = commands.prepareOrganizationUpgrade(f.confirm).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let waiting = false;
      for (let i = 0; i < 500; i++) {
        const result = await db.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query ILIKE '%organizations%FOR UPDATE%'",
          [schema],
        );
        if (result.rowCount) {
          waiting = true;
          break;
        }
        await Bun.sleep(20);
      }
      expect(waiting).toBe(true);
      await holder.query("UPDATE users SET role='member' WHERE id=$1", [f.input.actorId]);
      await holder.query("COMMIT");
      expect(await pending).toMatchObject({
        error: { code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN" },
      });
      expect(await count(f.input.organizationId)).toBe(0);
    } finally {
      await holder.query("ROLLBACK");
      await pending;
      await holder.end();
    }
  });
  async function dispatchCandidate(expiryMs?: number) {
    const f = await seed();
    if (expiryMs !== undefined) {
      f.quote = await quotes.saveOrganizationUpgradeQuote({
        identity: f.input,
        captured: f.captured,
        providerBinding: f.providerBinding,
        review: { ...f.review, expiresAt: new Date(Date.now() + expiryMs).toISOString() },
      });
    }
    const commandId = randomUUID();
    await db.query(
      `INSERT INTO billing_subscription_commands
      (id,organization_id,requested_by_user_id,subscription_id,expected_subscription_revision,
       kind,target_plan_key,idempotency_key,provider_idempotency_key,request_digest,
       organization_upgrade_dispatch_state)
      VALUES($1,$2,$3,$4,1,'upgrade','pro_monthly',$5,$6,$7,'ready')`,
      [
        commandId,
        f.input.organizationId,
        f.input.actorId,
        f.input.subscriptionId,
        randomUUID(),
        randomUUID(),
        "a".repeat(64),
      ],
    );
    await db.query(
      `UPDATE organization_plan_change_quotes SET consumed_by_command_id=$1,
      consumed_at=clock_timestamp() WHERE id=$2`,
      [commandId, f.quote.id],
    );
    return { ...f, commandId };
  }
  async function leaseCandidate(commandId: string) {
    await db.query(
      `UPDATE billing_subscription_commands SET status='OUTCOME_UNKNOWN',
      execution_generation=execution_generation+1,state_revision=state_revision+1,
      provider_started_at=COALESCE(provider_started_at,clock_timestamp()),
      lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1`,
      [commandId, randomUUID()],
    );
  }
  test("dispatch requires a previously acquired live lease and cannot reset after recovery", async () => {
    const f = await dispatchCandidate();
    await expect(
      db.query(
        `UPDATE billing_subscription_commands
      SET organization_upgrade_dispatch_state='started' WHERE id=$1`,
        [f.commandId],
      ),
    ).rejects.toThrow();
    await leaseCandidate(f.commandId);
    await db.query(
      `UPDATE billing_subscription_commands
      SET organization_upgrade_dispatch_state='started' WHERE id=$1`,
      [f.commandId],
    );
    await db.query(
      `UPDATE billing_subscription_commands SET lease_token=NULL,lease_expires_at=NULL WHERE id=$1`,
      [f.commandId],
    );
    await leaseCandidate(f.commandId);
    for (const value of ["ready", null]) {
      await expect(
        db.query(
          `UPDATE billing_subscription_commands SET organization_upgrade_dispatch_state=$2 WHERE id=$1`,
          [f.commandId, value],
        ),
      ).rejects.toThrow();
    }
    const row = (
      await db.query(
        `SELECT organization_upgrade_dispatch_state,execution_generation FROM billing_subscription_commands WHERE id=$1`,
        [f.commandId],
      )
    ).rows[0];
    expect(row.organization_upgrade_dispatch_state).toBe("started");
    expect(Number(row.execution_generation)).toBe(2);
  });
  test("legacy command cannot gain unstarted provenance or dispatch without its quote", async () => {
    const f = await seed();
    const original = { command: { id: randomUUID() } };
    await db.query(
      `INSERT INTO billing_subscription_commands
      (id,organization_id,requested_by_user_id,subscription_id,expected_subscription_revision,kind,target_plan_key,idempotency_key,provider_idempotency_key,request_digest)
      VALUES($1,$2,$3,$4,1,'upgrade','pro_monthly',$5,$6,$7)`,
      [
        original.command.id,
        f.input.organizationId,
        f.input.actorId,
        f.input.subscriptionId,
        randomUUID(),
        randomUUID(),
        "c".repeat(64),
      ],
    );
    await expect(
      db.query(
        `UPDATE billing_subscription_commands SET organization_upgrade_dispatch_state='ready' WHERE id=$1`,
        [original.command.id],
      ),
    ).rejects.toThrow();
    const orphan = await dispatchCandidate();
    // A new command has no consumed quote, even when its organization and plan match.
    const id = randomUUID();
    await db.query(
      `INSERT INTO billing_subscription_commands
      (id,organization_id,requested_by_user_id,subscription_id,expected_subscription_revision,kind,target_plan_key,idempotency_key,provider_idempotency_key,request_digest,organization_upgrade_dispatch_state)
      VALUES($1,$2,$3,$4,1,'upgrade','pro_monthly',$5,$6,$7,'ready')`,
      [
        id,
        orphan.input.organizationId,
        orphan.input.actorId,
        orphan.input.subscriptionId,
        randomUUID(),
        randomUUID(),
        "b".repeat(64),
      ],
    );
    await leaseCandidate(id);
    await expect(
      db.query(
        `UPDATE billing_subscription_commands SET organization_upgrade_dispatch_state='started' WHERE id=$1`,
        [id],
      ),
    ).rejects.toThrow();
  });
  test("expired dispatch lease cannot cross the provider boundary", async () => {
    const f = await dispatchCandidate();
    await leaseCandidate(f.commandId);
    await db.query(
      `UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [f.commandId],
    );
    await expect(
      db.query(
        `UPDATE billing_subscription_commands SET organization_upgrade_dispatch_state='started' WHERE id=$1`,
        [f.commandId],
      ),
    ).rejects.toThrow();
  });
  test("dispatch cannot replace the lease in the same write", async () => {
    const f = await dispatchCandidate();
    await leaseCandidate(f.commandId);
    await expect(
      db.query(
        `UPDATE billing_subscription_commands
      SET organization_upgrade_dispatch_state='started',lease_token=$2 WHERE id=$1`,
        [f.commandId, randomUUID()],
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.query(
          `SELECT organization_upgrade_dispatch_state FROM billing_subscription_commands WHERE id=$1`,
          [f.commandId],
        )
      ).rows[0].organization_upgrade_dispatch_state,
    ).toBe("ready");
  });
  test("dispatch cannot revive an expired lease in the same write", async () => {
    const f = await dispatchCandidate();
    await leaseCandidate(f.commandId);
    await db.query(
      `UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [f.commandId],
    );
    await expect(
      db.query(
        `UPDATE billing_subscription_commands SET organization_upgrade_dispatch_state='started',
        lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1`,
        [f.commandId],
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.query(
          `SELECT organization_upgrade_dispatch_state FROM billing_subscription_commands WHERE id=$1`,
          [f.commandId],
        )
      ).rows[0].organization_upgrade_dispatch_state,
    ).toBe("ready");
  });
  test("a consumed quote must still be live when the first dispatch starts", async () => {
    const f = await dispatchCandidate(2000);
    await leaseCandidate(f.commandId);
    await Bun.sleep(Math.max(0, f.quote.expires_at.getTime() - Date.now()) + 50);
    await expect(
      db.query(
        `UPDATE billing_subscription_commands
      SET organization_upgrade_dispatch_state='started' WHERE id=$1`,
        [f.commandId],
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.query(
          `SELECT organization_upgrade_dispatch_state FROM billing_subscription_commands WHERE id=$1`,
          [f.commandId],
        )
      ).rows[0].organization_upgrade_dispatch_state,
    ).toBe("ready");
  });
  async function executionCandidate() {
    const f = await seed();
    const admitted = await commands.prepareOrganizationUpgrade(f.confirm);
    return {
      ...f,
      identity: {
        organizationId: f.input.organizationId,
        actorId: f.input.actorId,
        commandId: admitted.command.id,
      },
    };
  }
  test("only one concurrent execution lease can dispatch; recovery never dispatches twice", async () => {
    const f = await executionCandidate();
    const attempts = await Promise.all([
      execution.claimOrganizationUpgrade(f.identity),
      execution.claimOrganizationUpgrade(f.identity),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const claim = attempts.find(Boolean)!;
    expect(claim.canDispatch).toBe(true);
    const source = await execution.readOrganizationUpgradeDispatchSource(f.identity, claim);
    expect(source.source.id).toBe(f.input.subscriptionId);
    expect(source.review).toEqual(f.review);
    await execution.markOrganizationUpgradeDispatch(f.identity, claim);
    await expect(execution.markOrganizationUpgradeDispatch(f.identity, claim)).rejects.toThrow();
    await execution.releaseOrganizationUpgrade(f.identity, claim);
    const recovery = (await execution.claimOrganizationUpgrade(f.identity))!;
    expect(recovery.canDispatch).toBe(false);
    await expect(execution.markOrganizationUpgradeDispatch(f.identity, recovery)).rejects.toThrow();
    await expect(
      execution.failOrganizationUpgradeBeforeDispatch(f.identity, recovery),
    ).rejects.toThrow();
  });
  test("a replacement lease fences old dispatch, release and failure callbacks", async () => {
    const f = await executionCandidate();
    const old = (await execution.claimOrganizationUpgrade(f.identity))!;
    await db.query(
      `UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [f.identity.commandId],
    );
    const fresh = (await execution.claimOrganizationUpgrade(f.identity))!;
    expect(fresh.command.execution_generation).toBe(old.command.execution_generation + 1);
    await expect(execution.markOrganizationUpgradeDispatch(f.identity, old)).rejects.toThrow();
    await expect(execution.releaseOrganizationUpgrade(f.identity, old)).rejects.toThrow();
    await expect(
      execution.failOrganizationUpgradeBeforeDispatch(f.identity, old),
    ).rejects.toThrow();
    const unchanged = await execution.finishOrganizationUpgradeAttempt(f.identity, old);
    expect(unchanged.lease_token).toBe(fresh.command.lease_token);
    expect(unchanged.execution_generation).toBe(fresh.command.execution_generation);
    await execution.markOrganizationUpgradeDispatch(f.identity, fresh);
  });
  test("manager revocation after claim prevents dispatch", async () => {
    const f = await executionCandidate();
    const claim = (await execution.claimOrganizationUpgrade(f.identity))!;
    await db.query(`UPDATE users SET role='member' WHERE id=$1`, [f.input.actorId]);
    await expect(execution.markOrganizationUpgradeDispatch(f.identity, claim)).rejects.toThrow();
    expect(
      (
        await db.query(
          `SELECT organization_upgrade_dispatch_state FROM billing_subscription_commands WHERE id=$1`,
          [f.identity.commandId],
        )
      ).rows[0].organization_upgrade_dispatch_state,
    ).toBe("ready");
  });
  for (const fence of ["revoked actor", "fenced organization"] as const) {
    for (const started of [false, true])
      test(`original lease cleanup survives ${fence}, started=${started}`, async () => {
        const f = await executionCandidate();
        const claim = (await execution.claimOrganizationUpgrade(f.identity))!;
        if (started) await execution.markOrganizationUpgradeDispatch(f.identity, claim);
        if (fence === "revoked actor")
          await db.query("UPDATE users SET role='member' WHERE id=$1", [f.input.actorId]);
        else
          await db.query(
            "UPDATE organizations SET paid_work_fenced_at=clock_timestamp() WHERE id=$1",
            [f.input.organizationId],
          );
        await expect(
          execution.readOrganizationUpgradeDispatchSource(f.identity, claim),
        ).rejects.toThrow();
        await expect(
          execution.markOrganizationUpgradeDispatch(f.identity, claim),
        ).rejects.toThrow();
        if (started) {
          await expect(
            execution.failOrganizationUpgradeBeforeDispatch(f.identity, claim),
          ).rejects.toThrow();
          await execution.releaseOrganizationUpgrade(f.identity, claim);
        } else await execution.failOrganizationUpgradeBeforeDispatch(f.identity, claim);
        const result = (
          await db.query(
            "SELECT status,organization_upgrade_dispatch_state AS dispatch,lease_token FROM billing_subscription_commands WHERE id=$1",
            [f.identity.commandId],
          )
        ).rows[0];
        expect(result).toEqual({
          status: started ? "OUTCOME_UNKNOWN" : "FAILED",
          dispatch: started ? "started" : "ready",
          lease_token: null,
        });
      });
  }
  test("cleanup never transfers the original actor or tenant authority", async () => {
    const f = await executionCandidate();
    const claim = (await execution.claimOrganizationUpgrade(f.identity))!;
    for (const identity of [
      { ...f.identity, actorId: randomUUID() },
      { ...f.identity, organizationId: randomUUID() },
    ]) {
      await expect(
        execution.failOrganizationUpgradeBeforeDispatch(identity, claim),
      ).rejects.toThrow();
      await expect(execution.releaseOrganizationUpgrade(identity, claim)).rejects.toThrow();
    }
    const result = (
      await db.query("SELECT status,lease_token FROM billing_subscription_commands WHERE id=$1", [
        f.identity.commandId,
      ])
    ).rows[0];
    expect(result).toEqual({ status: "OUTCOME_UNKNOWN", lease_token: claim.command.lease_token });
  });
  test("a current manager can review after an expired unstarted intent's actor is revoked", async () => {
    const f = await seed();
    const expiry = new Date(Date.now() + 2000);
    const quote = await quotes.saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      providerBinding: f.providerBinding,
      review: { ...f.review, expiresAt: expiry.toISOString() },
    });
    const admitted = await commands.prepareOrganizationUpgrade({ ...f.confirm, quoteId: quote.id });
    const administrator = randomUUID();
    await db.query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'admin')", [
      administrator,
      f.input.organizationId,
    ]);
    await db.query("UPDATE users SET role='member' WHERE id=$1", [f.input.actorId]);
    await Bun.sleep(Math.max(0, expiry.getTime() - Date.now()) + 50);
    const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
    await expect(
      readOrganizationPlanChangeSource({ ...f.input, actorId: administrator }),
    ).resolves.toMatchObject({ source: { id: f.input.subscriptionId } });
    expect(
      (
        await db.query(
          "SELECT status,organization_upgrade_dispatch_state FROM billing_subscription_commands WHERE id=$1",
          [admitted.command.id],
        )
      ).rows[0],
    ).toEqual({ status: "SUPERSEDED", organization_upgrade_dispatch_state: "ready" });
    expect(
      (
        await db.query(
          "SELECT consumed_by_command_id,actor_id FROM organization_plan_change_quotes WHERE id=$1",
          [quote.id],
        )
      ).rows[0],
    ).toEqual({ consumed_by_command_id: admitted.command.id, actor_id: f.input.actorId });
  });
  for (const state of ["live lease", "started effect", "released unstarted lease"] as const) {
    test(`fresh manager review preserves ${state} after original actor revocation`, async () => {
      const f = await seed();
      const expiry = new Date(Date.now() + 2000);
      const quote = await quotes.saveOrganizationUpgradeQuote({
        identity: f.input,
        captured: f.captured,
        providerBinding: f.providerBinding,
        review: { ...f.review, expiresAt: expiry.toISOString() },
      });
      const admitted = await commands.prepareOrganizationUpgrade({
        ...f.confirm,
        quoteId: quote.id,
      });
      const identity = {
        organizationId: f.input.organizationId,
        actorId: f.input.actorId,
        commandId: admitted.command.id,
      };
      const claim = (await execution.claimOrganizationUpgrade(identity))!;
      if (state === "started effect")
        await execution.markOrganizationUpgradeDispatch(identity, claim);
      if (state !== "live lease") await execution.releaseOrganizationUpgrade(identity, claim);
      const administrator = randomUUID();
      await db.query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'admin')", [
        administrator,
        f.input.organizationId,
      ]);
      await db.query("UPDATE users SET role='member' WHERE id=$1", [f.input.actorId]);
      await Bun.sleep(Math.max(0, expiry.getTime() - Date.now()) + 50);
      const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
      const review = readOrganizationPlanChangeSource({ ...f.input, actorId: administrator });
      if (state === "released unstarted lease")
        await expect(review).resolves.toMatchObject({ source: { id: f.input.subscriptionId } });
      else await expect(review).rejects.toThrow();
      const persisted = (
        await db.query(
          "SELECT status,organization_upgrade_dispatch_state,lease_token FROM billing_subscription_commands WHERE id=$1",
          [identity.commandId],
        )
      ).rows[0];
      expect(persisted.status).toBe(
        state === "released unstarted lease" ? "FAILED" : "OUTCOME_UNKNOWN",
      );
      expect(persisted.organization_upgrade_dispatch_state).toBe(
        state === "started effect" ? "started" : "ready",
      );
      expect(persisted.lease_token).toBe(state === "live lease" ? claim.command.lease_token : null);
    });
  }
  test("changed customer blocks dispatch but a ready lease can retire the command", async () => {
    const f = await executionCandidate();
    const claim = (await execution.claimOrganizationUpgrade(f.identity))!;
    await db.query(`UPDATE organizations SET stripe_customer_id='cus_changed' WHERE id=$1`, [
      f.input.organizationId,
    ]);
    await expect(execution.markOrganizationUpgradeDispatch(f.identity, claim)).rejects.toThrow();
    await execution.failOrganizationUpgradeBeforeDispatch(f.identity, claim);
    expect(
      (
        await db.query(`SELECT status FROM billing_subscription_commands WHERE id=$1`, [
          f.identity.commandId,
        ])
      ).rows[0].status,
    ).toBe("FAILED");
  });
  test("expired unclaimed review is superseded and releases admission for a fresh quote", async () => {
    const f = await seed();
    const expiry = new Date(Date.now() + 2000);
    const quote = await quotes.saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      providerBinding: f.providerBinding,
      review: { ...f.review, expiresAt: expiry.toISOString() },
    });
    const admitted = await commands.prepareOrganizationUpgrade({ ...f.confirm, quoteId: quote.id });
    await Bun.sleep(Math.max(0, expiry.getTime() - Date.now()) + 50);
    expect(
      await execution.claimOrganizationUpgrade({
        organizationId: f.input.organizationId,
        actorId: f.input.actorId,
        commandId: admitted.command.id,
      }),
    ).toBeNull();
    expect(
      (
        await db.query(`SELECT status FROM billing_subscription_commands WHERE id=$1`, [
          admitted.command.id,
        ])
      ).rows[0].status,
    ).toBe("SUPERSEDED");
    const fresh = await quotes.saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      providerBinding: f.providerBinding,
      review: f.review,
    });
    expect(fresh.id).not.toBe(quote.id);
  });
  test("a released unstarted lease can expire without trapping the organization", async () => {
    const f = await seed();
    const expiry = new Date(Date.now() + 2000);
    const quote = await quotes.saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      providerBinding: f.providerBinding,
      review: { ...f.review, expiresAt: expiry.toISOString() },
    });
    const admitted = await commands.prepareOrganizationUpgrade({ ...f.confirm, quoteId: quote.id });
    const identity = {
      organizationId: f.input.organizationId,
      actorId: f.input.actorId,
      commandId: admitted.command.id,
    };
    const claim = (await execution.claimOrganizationUpgrade(identity))!;
    await execution.releaseOrganizationUpgrade(identity, claim);
    await Bun.sleep(Math.max(0, expiry.getTime() - Date.now()) + 50);
    expect(await execution.claimOrganizationUpgrade(identity)).toBeNull();
    expect(
      (
        await db.query(
          `SELECT status,organization_upgrade_dispatch_state FROM billing_subscription_commands WHERE id=$1`,
          [identity.commandId],
        )
      ).rows[0],
    ).toEqual({ status: "FAILED", organization_upgrade_dispatch_state: "ready" });
    expect(
      (
        await quotes.saveOrganizationUpgradeQuote({
          identity: f.input,
          captured: f.captured,
          providerBinding: f.providerBinding,
          review: f.review,
        })
      ).id,
    ).not.toBe(quote.id);
  });
  test("a claim cannot be used for a different command or actor", async () => {
    const a = await executionCandidate(),
      b = await executionCandidate();
    const claim = (await execution.claimOrganizationUpgrade(a.identity))!;
    await expect(execution.markOrganizationUpgradeDispatch(b.identity, claim)).rejects.toThrow();
    await expect(
      execution.markOrganizationUpgradeDispatch({ ...a.identity, actorId: b.input.actorId }, claim),
    ).rejects.toThrow();
    await execution.markOrganizationUpgradeDispatch(a.identity, claim);
  });
  test("another pending intent remains a dispatch conflict", async () => {
    const f = await executionCandidate();
    const claim = (await execution.claimOrganizationUpgrade(f.identity))!;
    await db.query(
      `INSERT INTO billing_subscription_commands
      (id,organization_id,requested_by_user_id,subscription_id,expected_subscription_revision,kind,idempotency_key,provider_idempotency_key,request_digest)
      VALUES($1,$2,$3,$4,1,'cancel',$5,$6,$7)`,
      [
        randomUUID(),
        f.input.organizationId,
        f.input.actorId,
        f.input.subscriptionId,
        randomUUID(),
        randomUUID(),
        "d".repeat(64),
      ],
    );
    await expect(execution.markOrganizationUpgradeDispatch(f.identity, claim)).rejects.toThrow();
  });
  test("review expiry cannot retire an already dispatched uncertain effect", async () => {
    const f = await seed();
    const expiry = new Date(Date.now() + 2000);
    const quote = await quotes.saveOrganizationUpgradeQuote({
      identity: f.input,
      captured: f.captured,
      providerBinding: f.providerBinding,
      review: { ...f.review, expiresAt: expiry.toISOString() },
    });
    const admitted = await commands.prepareOrganizationUpgrade({ ...f.confirm, quoteId: quote.id });
    const identity = {
      organizationId: f.input.organizationId,
      actorId: f.input.actorId,
      commandId: admitted.command.id,
    };
    const claim = (await execution.claimOrganizationUpgrade(identity))!;
    await execution.markOrganizationUpgradeDispatch(identity, claim);
    await execution.releaseOrganizationUpgrade(identity, claim);
    await Bun.sleep(Math.max(0, expiry.getTime() - Date.now()) + 50);
    const recovery = (await execution.claimOrganizationUpgrade(identity))!;
    expect(recovery.canDispatch).toBe(false);
    expect(recovery.command.status).toBe("OUTCOME_UNKNOWN");
    await expect(
      execution.failOrganizationUpgradeBeforeDispatch(identity, recovery),
    ).rejects.toThrow();
  });
});
