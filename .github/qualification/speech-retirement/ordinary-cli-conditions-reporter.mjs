/** Read-only actual CLI server/worker-transport configuration; no SDK/value import. */
import fs from 'node:fs';
function list(value){
  return Array.isArray(value)&&value.length<=64&&value.every(item=>typeof item==='string'&&item.length<=512)?value:null;
}
export default class OrdinaryConditionsReporter {
  onInit(context){this.context=context;}
  onTestRunStart(specifications){
    try{
      const phase=process.env.ORDINAL_DIAGNOSTIC_PHASE;
      if(!/^owning-[0-2]$/.test(phase??''))throw Error('Unknown diagnostic phase');
      const projects=new Set([this.context.getRootProject()]);
      for(const specification of specifications??[])if(specification.project)projects.add(specification.project);
      if(projects.size>8)throw Error('Project metadata bound');
      const rows=[];
      for(const project of projects){
        const server=project.vite,environment=server?.environments?.__vitest__,ssr=server?.environments?.ssr;
        rows.push({root:project.config?.root??null,configFile:server?.config?.configFile??null,pool:project.config?.pool??null,maxWorkers:project.config?.maxWorkers??null,sourceConditions:list(server?.config?.resolve?.conditions),actualWorkerTransportEnvironment:'__vitest__',workerTransportConditions:list(environment?.config?.resolve?.conditions),workerTransportExternalConditions:list(environment?.config?.resolve?.externalConditions),ssrConditions:list(ssr?.config?.resolve?.conditions),ssrExternalConditions:list(ssr?.config?.resolve?.externalConditions),fsModuleCachePath:project.config?.fsModuleCachePath??null});
      }
      const text=JSON.stringify({state:'ACTUAL_ORDINARY_CLI_RESOLVED_PROJECT_AND_WORKER_TRANSPORT_CONFIG_NOT_MODULE_OR_ASSERTION_PASS',phase,observedIn:'CLI reporter callback onTestRunStart',projects:rows,workerProcessNodeArgsObservedSeparately:true,SDKOrTestValueImportedByReporter:false})+'\n';
      if(Buffer.byteLength(text)>32768)throw Error('CLI conditions byte bound');
      fs.writeFileSync(`/results/CLI-CONDITIONS-${phase}.json`,text,{flag:'wx',mode:0o600});
    }catch(error){
      try{process.stderr.write(`[ORDINAL_CLI_CONDITIONS_UNAVAILABLE] ${String(error?.message??error).slice(0,256)}\n`);}catch{}
    }
  }
}
