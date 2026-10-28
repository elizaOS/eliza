import {describe, expect, it, vi} from "vitest";
import type {LifeOpsReminderAttempt} from "@elizaos/contracts";
import {RemindersDomain} from "./reminders-service.js";

describe("reminder read receipt authority", () => {
  function fixture(channel: LifeOpsReminderAttempt["channel"], outcome: LifeOpsReminderAttempt["outcome"] = "delivered") {
    const update = vi.fn(async () => {});
    const notices: Record<string,unknown>[]=[];
    const context = {agentId:()=>"agent", runtime:{getService:()=>({listDurableIncludingExpired:async()=>notices})}, repository: {updateReminderAttemptOutcome: update}, logLifeOpsWarn: vi.fn()} as unknown as ConstructorParameters<typeof RemindersDomain>[0];
    const domain = new RemindersDomain(context, {} as ConstructorParameters<typeof RemindersDomain>[1]);
    const attempt = {id: "existing-attempt", agentId:"agent", ownerType:"occurrence", ownerId:"occurrence", scheduledFor:"2026-10-28T09:56:30.000Z", deliveryMetadata:{notificationId:"notice"}, channel, outcome, attemptedAt: "2026-10-28T09:56:30.000Z"} as LifeOpsReminderAttempt;
    const activity = {lastSeenAt: Date.parse("2026-10-28T09:57:00.000Z")} as Parameters<RemindersDomain["scanReadReceipts"]>[1];
    return {domain, attempt, activity, update, notices};
  }
  it("does not treat unrelated activity as reading an in-app reminder", async () => {
    const f = fixture("in_app");
    await f.domain.scanReadReceipts([f.attempt], f.activity, new Date("2026-10-28T09:58:00.000Z"));
    expect(f.update).not.toHaveBeenCalled();
    expect(f.attempt.outcome).toBe("delivered");
  });
  it("does not rewrite historical in-app read receipts", async () => {
    const f = fixture("in_app", "delivered_read");
    await f.domain.scanReadReceipts([f.attempt], f.activity, new Date("2026-10-28T09:58:00.000Z"));
    expect(f.update).not.toHaveBeenCalled();
    expect(f.attempt.outcome).toBe("delivered_read");
  });
  it("preserves existing non-app channel reachability behavior", async () => {
    const f = fixture("sms");
    await f.domain.scanReadReceipts([f.attempt], f.activity, new Date("2026-10-28T09:58:00.000Z"));
    expect(f.update).toHaveBeenCalledExactlyOnceWith("existing-attempt", "delivered_read", {readDetectedAt: "2026-10-28T09:58:00.000Z"});
  });
  it("never invents a receipt when activity is unknown", async () => {
    const f = fixture("sms");
    await f.domain.scanReadReceipts([f.attempt], null, new Date("2026-10-28T09:58:00.000Z"));
    expect(f.update).not.toHaveBeenCalled();
  });
  it("records an explicit read of the exact owned notification without general activity", async () => {
    const f=fixture("in_app");
    f.notices.push({id:"notice",agentId:"agent",source:"lifeops",category:"reminder",groupKey:"reminder:occurrence:occurrence",data:{ownerType:"occurrence",ownerId:"occurrence",scheduledFor:f.attempt.scheduledFor},createdAt:Date.parse(f.attempt.attemptedAt!),readAt:Date.parse("2026-10-28T09:57:00.000Z")});
    await f.domain.scanReadReceipts([f.attempt],null,new Date("2026-10-28T09:58:00.000Z"));
    expect(f.attempt.outcome).toBe("delivered_read");
    expect(f.update).toHaveBeenCalledExactlyOnceWith("existing-attempt","delivered_read",{notificationId:"notice",readDetectedAt:"2026-10-28T09:57:00.000Z",readEvidence:"notification_read"});
    await f.domain.scanReadReceipts([f.attempt],null,new Date("2026-10-28T09:59:00.000Z"));
    expect(f.update).toHaveBeenCalledTimes(1);
  });
  it.each(["id","agentId","groupKey","ownerId","scheduledFor","unread","missingAttemptTime","invalidAttemptTime","invalidCreatedTime"])("rejects unrelated or unread notification evidence: %s",async fault=>{
    const f=fixture("in_app");const row={id:"notice",agentId:"agent",source:"lifeops",category:"reminder",groupKey:"reminder:occurrence:occurrence",data:{ownerType:"occurrence",ownerId:"occurrence",scheduledFor:f.attempt.scheduledFor},createdAt:Date.parse(f.attempt.attemptedAt!),readAt:Date.parse("2026-10-28T09:57:00.000Z")};
    if(fault==="id")row.id="other";if(fault==="agentId")row.agentId="other";if(fault==="groupKey")row.groupKey="other";if(fault==="ownerId")row.data.ownerId="other";if(fault==="scheduledFor")row.data.scheduledFor="2026-10-29T09:56:30.000Z";if(fault==="unread")row.readAt=0;if(fault==="missingAttemptTime")f.attempt.attemptedAt=null;if(fault==="invalidAttemptTime")f.attempt.attemptedAt="invalid";if(fault==="invalidCreatedTime")row.createdAt=NaN;
    f.notices.push(row);await f.domain.scanReadReceipts([f.attempt],f.activity,new Date("2026-10-28T09:58:00.000Z"));expect(f.update).not.toHaveBeenCalled();expect(f.attempt.outcome).toBe("delivered");
  });

  it("waits for durable notification evidence before upgrading an attempt",async()=>{
    const f=fixture("in_app");let finish!:(value:never[])=>void;
    const pending=new Promise<never[]>(resolve=>{finish=resolve;});
    const read=vi.spyOn((f.domain as unknown as {ctx:{runtime:{getService:()=>unknown}}}).ctx.runtime,"getService").mockReturnValue({listDurableIncludingExpired:()=>pending});
    const scan=f.domain.scanReadReceipts([f.attempt],null,new Date("2026-10-28T09:58:00.000Z"));
    await Promise.resolve();expect(f.update).not.toHaveBeenCalled();finish([]);await scan;expect(f.update).not.toHaveBeenCalled();read.mockRestore();
  });

});
