// Exact production planner try/catch and settled-result selector, finite ports only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transform } from "esbuild";
import ts from "typescript";

const text = readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");
const file = ts.createSourceFile(
  "pipeline.ts",
  text,
  ts.ScriptTarget.Latest,
  true,
);
let boundary, phaseDeclaration;
function walk(n) {
  if (
    ts.isTryStatement(n) &&
    n.tryBlock.statements[0]?.getText(file).startsWith("plannerResult =") &&
    n.tryBlock.getText(file).includes("await persistPlannerContinuation(")
  )
    boundary = n;
  if (
    ts.isVariableDeclaration(n) &&
    n.name.getText(file) === "plannerFailurePhase"
  )
    phaseDeclaration = "let " + n.getText(file) + ";";
  ts.forEachChild(n, walk);
}
walk(file);
assert.ok(boundary);
assert.ok(phaseDeclaration);
const reports = [];
function reportWalk(n) {
  if (
    ts.isCallExpression(n) &&
    n.expression.getText(file) === "args.runtime.reportError" &&
    n.arguments[0]?.getText(file) === '"MessageService.plannerLoop"'
  )
    reports.push(n);
  ts.forEachChild(n, reportWalk);
}
reportWalk(boundary.catchClause);
assert.equal(reports.length, 4);
const policy = ts.createSourceFile(
  "reply-policy.ts",
  readFileSync(new URL("./reply-policy.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const fn = policy.statements.find(
  (n) =>
    ts.isFunctionDeclaration(n) &&
    n.name?.text === "preservedSettledToolResult",
);
assert.ok(fn);
const fixture = `export async function scenario(target,messageId='message-A',hostile=false){let writes=0,persistCalls=0,releases=0,endStatus='unknown';const errors=[];const error=Error('private diagnostic must not leak');if(hostile)for(const name of ['message','stack','response','responseBody','status','statusCode'])Object.defineProperty(error,name,{get(){throw Error('Forbidden getter');}});const receipt={receiptId:'synthetic-note-effect',operation:'notes.note.create',outcome:'applied',commit:{kind:'durable',id:'synthetic-note'}};const action={success:true,transcriptVisibility:'internal',modelReplyRequired:true,effectReceipts:[receipt],data:{noteId:'synthetic-note'}};const settledPlannerToolResults=[],callbackActionResults=[],callbackToolCallIds=new Map();const deliveredVisibleTexts=new Set();const args={runtime:{reportError:(scope,cause,context)=>{assertSame(cause,error);errors.push({scope,context});}},message:{id:messageId,roomId:'room',content:{text:'Create synthetic note'}},codingMode:false};const assertSame=(a,b)=>{if(a!==b)throw Error('Original error replaced');};const messageHandler={plan:{},thought:''},resumedPlanner=undefined,plannerState={},plannerContextAfterEarlyReply={};let observedPlannerTrajectory;const exposedPlannerActions=[];const invokePlannerLoop=async()=>{writes++;settledPlannerToolResults.push({name:'NOTES_CREATE',result:action});callbackActionResults.push(action);callbackToolCallIds.set(0,'call');if(target==='execution')throw error;return {trajectory:{steps:[],archivedSteps:[],plannedQueue:[]}};};const invokeDeterministicToolCall=invokePlannerLoop,timeInferenceSpan=async(_,f)=>f();const persistPlannerContinuation=async()=>{persistCalls++;if(target==='continuation_persistence')throw error;};const releaseFactsStage=()=>{releases++;if(target==='release_facts')throw error;};let abortChecks=0;const getStreamingContext=()=>target==='post_execution_abort_check'?{abortSignal:{throwIfAborted(){if(abortChecks++===0)throw error;}}}:undefined,TurnAbortedError=class extends Error{},PostEffectEvaluationError=class extends Error{},isRecord=v=>v!==null&&typeof v==='object',isProviderContextOverflowFailure=()=>false,isRateLimitError=()=>false,readProviderRateLimit=()=>undefined;const collectPreviousActionResults=()=>{throw Error('No observed trajectory in this fixture');};const isTerminalPlannerToolName=()=>false,normalizeVisibleTextForDuplicateCheck=s=>s,deliveredTextsCoverReply=()=>false,subAgentCompletionRelayBody=()=>undefined,sanitizeUserVisibleModelOutput=s=>({kind:'text',text:s}),createV5ReplyStrategyResult=p=>({responseContent:{text:p.text},terminalFailure:p.terminalFailure});${fn.getText(policy).replace(/^export\s+/, "")}let plannerResult;${phaseDeclaration}const run=async()=>{${boundary.getText(file)}};const result=await run();return {result,errors,writes,persistCalls,releases,receipt,action,endStatus};}`;
const api = await import(
  "data:text/javascript;base64," +
    Buffer.from(
      (
        await transform(fixture, {
          loader: "ts",
          format: "esm",
          target: "es2022",
        })
      ).code,
    ).toString("base64")
);
for (const target of [
  "execution",
  "continuation_persistence",
  "release_facts",
  "post_execution_abort_check",
])
  for (const id of ["message-A", "message-B"])
    test(
      target +
        " failure correlates " +
        id +
        " and preserves the one committed effect without success or replay",
      async () => {
        const r = await api.scenario(target, id);
        assert.equal(r.writes, 1);
        assert.equal(r.result.result.requestFulfilled, false);
        assert.equal(
          r.result.result.terminalFailure.code,
          "PLANNER_INTERRUPTED_AFTER_ACTION",
        );
        assert.equal(r.result.result.actionResults[0], r.action);
        assert.equal(r.action.effectReceipts[0], r.receipt);
        assert.deepEqual(r.errors, [
          {
            scope: "MessageService.plannerLoop",
            context: {
              roomId: "room",
              messageId: id,
              plannerFailurePhase: target,
            },
          },
        ]);
        assert.doesNotMatch(
          r.result.result.responseContent.text,
          /private diagnostic/,
        );
        assert.equal(r.endStatus, "errored");
      },
    );
test("correlation metadata never reads original message, stack, provider or status getters", async () => {
  const r = await api.scenario("execution", "message-C", true);
  assert.deepEqual(r.errors[0].context, {
    roomId: "room",
    messageId: "message-C",
    plannerFailurePhase: "execution",
  });
  assert.equal(r.writes, 1);
});
test("all matching catch-report sites use exact message and finite phase without copying error data", () => {
  for (const report of reports) {
    const context = report.arguments[2];
    assert.ok(ts.isObjectLiteralExpression(context));
    assert.deepEqual(
      context.properties.map((p) => p.name.getText(file)),
      ["roomId", "messageId", "plannerFailurePhase"],
    );
    assert.equal(report.arguments[1].getText(file), "error");
  }
});
