import {describe,it,expect,vi} from 'vitest';
import {createStartupPoll, type PollingBackendDeps} from '../startup-phase-poll';
import type {StartupHostPorts} from '../startup-host-ports';
function fixture(){
 const calls:string[]=[];let base='eliza-local-agent://ipc';let release!:()=>void;
 const hold=new Promise<void>(r=>release=r);const parent=new AbortController();const cancelled={current:false};const run={current:1};
 const ports={platform:{isAndroid:true,isIOS:false,isCapacitorNative:()=>true,isElectrobunRuntime:()=>false},configuration:{supportsFullAppShellRoutes:()=>true,isViteDevUiShell:()=>false},transport:{client:{getBaseUrl:()=>base,hasToken:()=>false,getAuthStatus:async()=>{calls.push('probe:'+base);return {required:true,authenticated:false,bootstrapRequired:true};}},prepareNativeRuntimeForUrl:async(url:string)=>{calls.push('prepare:'+url);await hold;},requestAndroidLocalAgentStartForUrl:async(url:string)=>{calls.push('start:'+url);return true;},getAndroidLocalAgentBootStateForUrl:async()=>{calls.push('boot-state');return {state:'unknown'};},isIosNativeAgentBootInProgress:()=>false,isTerminalIosNativeAgentBootErrorMessage:()=>false,appendIosBootTrace:()=>{}}} as unknown as StartupHostPorts;
 const deps={firstRunCompletionCommittedRef:{current:false},setAuthRequired:vi.fn(),setFirstRunCloudProvisionedContainer:vi.fn(),setFirstRunComplete:vi.fn(),setFirstRunLoading:vi.fn()} as unknown as PollingBackendDeps;
 const start=()=>createStartupPoll(ports).runPollingBackend(deps,vi.fn(),{backendTimeoutMs:30000,allowLocalOriginRecovery:false} as never,{persistedActiveServer:{kind:'local'}} as never,1,run,cancelled,{current:null},'embedded-local',parent.signal);
 return {calls,release,setBase:(value:string)=>base=value,parent,cancelled,start};
}
describe('native preparation owner retirement regressions',()=>{
 it('prepares the selected base before starting/probing it',async()=>{const f=fixture();const pending=f.start();await Promise.resolve();f.setBase('https://next.example');f.release();await pending;expect(f.calls).toEqual(['prepare:eliza-local-agent://ipc','prepare:https://next.example','start:https://next.example','probe:https://next.example']);});
 it('does not perform native boot reads after cancellation of admission',async()=>{vi.useFakeTimers();try{const f=fixture();const pending=f.start();await Promise.resolve();f.cancelled.current=true;f.parent.abort();await vi.advanceTimersByTimeAsync(1000);await pending;expect(f.calls).toEqual(['prepare:eliza-local-agent://ipc']);expect(vi.getTimerCount()).toBe(0);}finally{vi.useRealTimers();}});
});
