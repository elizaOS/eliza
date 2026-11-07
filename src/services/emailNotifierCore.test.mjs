import test from "node:test";
import assert from "node:assert/strict";
import { EmailNotifier } from "./emailNotifierCore.mjs";
const context = { userId: "u1", tenantId: "t1" };
const payload = { subject: "Health observation", body: "Probe unavailable", audience: "user" };
function fixture(overrides = {}) {
  const calls = [];
  const notifier = new EmailNotifier({
    env: { RESEND_API_KEY: "test-fixture", NOTIFICATION_FROM: "updates@example.test", MASTER_ADMIN_EMAIL: "admin@example.test" },
    resolveUser: async c => ({ id: c.userId, tenantId: c.tenantId, email: `${c.userId}@example.test`, emailVerified: true, notificationsEnabled: true }),
    fetchImpl: async (url, options) => { calls.push(JSON.parse(options.body)); return new Response(JSON.stringify({ id: "accepted-id" }), { status: 200 }); },
    ...overrides
  });
  return { notifier, calls };
}
test("two accounts remain isolated", async () => {
  const {notifier, calls} = fixture();
  assert.equal(await notifier.sendEmail(payload, context), true);
  assert.equal(await notifier.sendEmail(payload, {userId:"u2", tenantId:"t2"}), true);
  assert.deepEqual(calls.map(c=>c.to), [["u1@example.test"],["u2@example.test"]]);
});
test("legacy or absent session fails closed without sending", async () => {
  const {notifier,calls} = fixture();
  for (const c of [undefined, "caller@example.test", {}, {userId:"u1"}]) assert.equal(await notifier.sendEmail(payload,c),false);
  assert.equal(calls.length,0);
});
test("missing identity resolver fails closed", async()=>{
  const {notifier,calls}=fixture({resolveUser:undefined});
  assert.equal(await notifier.sendEmail(payload,context),false); assert.equal(calls.length,0);
});
test("unverified disabled and mismatched identities fail closed", async()=>{
  for(const patch of [{emailVerified:false},{notificationsEnabled:false},{id:"u2"},{tenantId:"t2"},{email:""}]) {
    const {notifier,calls}=fixture({resolveUser:async()=>({id:"u1",tenantId:"t1",email:"u1@example.test",emailVerified:true,notificationsEnabled:true,...patch})});
    assert.equal(await notifier.sendEmail(payload,context),false); assert.equal(calls.length,0);
  }
});
test("no recipient override or admin fallback",async()=>{
  const {notifier,calls}=fixture();
  assert.equal(await notifier.sendEmail({...payload,to:"other@example.test"},context),false);
  assert.equal(notifier.resolveRecipient(undefined,"user"),null);
  assert.equal(await notifier.sendEmail({...payload,audience:"admin"},context),false);
  assert.equal(calls.length,0);
});
test("admin notifications require explicit authorization and configured recipient",async()=>{
  const {notifier,calls}=fixture({authorizeAdmin:async()=>true});
  assert.equal(await notifier.sendEmail({...payload,audience:"admin"},context),true);
  assert.deepEqual(calls[0].to,["admin@example.test"]);
  const absent=fixture({authorizeAdmin:async()=>true,env:{RESEND_API_KEY:"test-fixture",NOTIFICATION_FROM:"updates@example.test"}});
  assert.equal(await absent.notifier.sendEmail({...payload,audience:"admin"},context),false);
});
test("missing credentials or sender never report simulated success",async()=>{
  for(const env of [{},{RESEND_API_KEY:"test-fixture"},{RESEND_API_KEY:"pplx-your_live_api_key_here",NOTIFICATION_FROM:"updates@example.test"}]){
    const {notifier,calls}=fixture({env}); assert.equal(await notifier.sendEmail(payload,context),false); assert.equal(calls.length,0);
  }
});
test("rejection malformed response and network failure never report success",async()=>{
  for(const fetchImpl of [async()=>new Response("rejected",{status:401}),async()=>new Response("{}"),async()=>{throw Error("offline");}]){
    const {notifier}=fixture({fetchImpl});assert.equal(await notifier.sendEmail(payload,context),false);
  }
});
test("invalid notification sizes or audience are refused",async()=>{
  const {notifier,calls}=fixture();
  for(const patch of [{subject:"a\nb"},{body:"x".repeat(20001)},{audience:"everyone"}])assert.equal(await notifier.sendEmail({...payload,...patch},context),false);
  assert.equal(calls.length,0);
});
