import {expect, test} from 'bun:test';
import {workflowRuntimeStatus} from '../../src/services/workflow-status';
import {buildAutomationListResponse} from '../../src/lib/automations-builder';

for (const [authoring, execution] of [[true, false], [false, true], [false, false]]) {
  test(`does not advertise execution with services ${authoring}/${execution}`, () => {
    expect(workflowRuntimeStatus(authoring, execution)).toEqual({
      mode:'disabled', host:null, status:'error', cloudConnected:false,
      localEnabled:false, platform:'runtime', executionLocation:'agent-runtime',
      cloudHealth:'unknown', engine:'smthrs',
      errorMessage:'Workflow authoring or execution service is not registered',
    });
  });
}
test('describes the embedded agent host without inferring cloud health', () => {
  const status = workflowRuntimeStatus(true, true);
  expect(status).toMatchObject({mode:'local', host:'eliza://workflow', status:'ready',
    localEnabled:true, executionLocation:'agent-runtime', cloudConnected:false, cloudHealth:'unknown'});
  expect(status.errorMessage).toBeUndefined();
});

for (const execution of [true, false]) {
  test(`automation status requires embedded service: ${execution}`, async () => {
    const runtime = {agentId:'00000000-0000-4000-8000-000000000001', character:{name:'QA'},
      getRooms:async()=>[], getTasks:async()=>[],
      getService:(name:string)=>name==='workflow'?{listWorkflows:async()=>[]}:
        name==='embedded_workflow_service' && execution ? {} : null};
    const response = await buildAutomationListResponse(runtime as any, 'owner');
    expect(response.workflowStatus).toEqual(workflowRuntimeStatus(true, execution));
  });
}
