import {describe,test,expect} from 'bun:test';
import {phoneGenerationInput,generatePhoneSpec} from '../src/services/phone-workflow-generation';
const device={installationId:'device-one',enrollmentId:'enrollment-one'};
const read={id:'read',kind:'Read',operation:'supplied_text',text:'Synthetic review text'};
const basic={version:1,name:'Draft',description:'',trigger:{kind:'manual'},steps:[read]};
const available=['supplied_text','selected_notes','calendar_range','compose_draft','model_draft','contains','save_note','app_notification','read_aloud'];
const input=(extra={})=>phoneGenerationInput({prompt:'Build a workflow',operations:available,device,...extra},available);
describe('typed generation',()=>{
 test('produces validated data bound only to the supplied enrollment',async()=>{
  const output={...basic,steps:[read,{id:'save',kind:'Write',operation:'save_note',source:'read',title:'Review'}]};let prompt='';
  const result=await generatePhoneSpec(input(),async value=>{prompt=value;return JSON.stringify(output);});
  expect(result).toEqual({...output,device});expect(prompt).not.toContain('enrollment-one');expect(prompt).toContain('Build a workflow');
 });
 test('supports an explicitly selected read scope without reading its content',async()=>{
  const notes={id:'notes',kind:'Read',operation:'selected_notes',notes:[{id:'note-one',revision:'a'.repeat(64)}]};
  const existing={...basic,device,steps:[notes]};const result=await generatePhoneSpec(input({existing}),async()=>JSON.stringify({...basic,steps:[notes]}));expect(result.steps).toEqual([notes]);
 });
 test('rejects invented and expanded Notes scopes',async()=>{
  const notes={id:'notes',kind:'Read',operation:'selected_notes',notes:[{id:'note-one',revision:'a'.repeat(64)}]};
  await expect(generatePhoneSpec(input(),async()=>JSON.stringify({...basic,steps:[notes]}))).rejects.toThrow('selected read scope');
  const existing={...basic,device,steps:[notes]};
  for(const changed of [{...notes,notes:[{id:'note-two',revision:'a'.repeat(64)}]},{...notes,notes:[{id:'note-one',revision:'b'.repeat(64)}]}]) await expect(generatePhoneSpec(input({existing}),async()=>JSON.stringify({...basic,steps:[changed]}))).rejects.toThrow('selected read scope');
 });
 test('rejects expanded Calendar ranges',async()=>{
  const step={id:'calendar',kind:'Read',operation:'calendar_range',range:{calendarIds:['calendar-one'],start:'2026-10-03T00:00:00.000Z',end:'2026-10-04T00:00:00.000Z',timeZone:'UTC',maximumEvents:10}};
  const existing={...basic,device,steps:[step]};
  await expect(generatePhoneSpec(input({existing}),async()=>JSON.stringify({...basic,steps:[{...step,range:{...step.range,end:'2026-10-05T00:00:00.000Z'}}]}))).rejects.toThrow('selected read scope');
 });
 test('refuses unavailable behavior visibly',async()=>{await expect(generatePhoneSpec(input(),async()=>JSON.stringify({unsupported:'Select a calendar first'}))).rejects.toThrow('Select a calendar first');});
 for(const [name,output] of Object.entries({source:{...basic,source:'process.exit()'},activation:{...basic,active:true},identity:{...basic,device},scheduled:{...basic,trigger:{kind:'time'}},reference:{...basic,steps:[{id:'save',kind:'Write',operation:'save_note',source:'later',title:'X'}]},send:{...basic,steps:[read,{id:'send',kind:'Send',operation:'send_email',source:'read'}]}})) test('rejects model '+name,async()=>{await expect(generatePhoneSpec(input(),async()=>JSON.stringify(output))).rejects.toThrow();});
 test('rejects malformed or oversized model responses',async()=>{for(const output of ['not JSON','[]','x'.repeat(65537)])await expect(generatePhoneSpec(input(),async()=>output)).rejects.toThrow();});
 test('respects client operation restrictions',async()=>{await expect(generatePhoneSpec(input({operations:['supplied_text']}),async()=>JSON.stringify({...basic,steps:[read,{id:'speak',kind:'Speak',operation:'read_aloud',source:'read'}]}))).rejects.toThrow('unavailable operation');});
 test('validates request bounds and capabilities before generation',()=>{for(const extra of [{prompt:''},{prompt:'x'.repeat(4001)},{operations:['unknown']},{operations:['supplied_text','supplied_text']},{source:'x'},{existing:{...basic,device},device:{installationId:'other',enrollmentId:'other'}}])expect(()=>input(extra)).toThrow();});
});
