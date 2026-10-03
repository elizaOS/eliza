import {afterEach,expect,test} from 'bun:test';
import {collectPluginNames} from '../src/runtime/plugin-collector';
const saved={...process.env};
afterEach(()=>{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
function selected(platform:string,enabled?:string,config={}){
 process.env.ELIZA_PLATFORM=platform;process.env.ELIZA_DISTRIBUTION_PROFILE='store';
 delete process.env.ELIZA_MOBILE_WORKFLOWS;
 if(enabled!==undefined)process.env.ELIZA_MOBILE_WORKFLOWS=enabled;
 return collectPluginNames(config);
}
test('Android workflow opt-in preserves mobile actuator exclusions',()=>{
 expect(selected('android').has('@elizaos/plugin-workflow')).toBe(false);
 expect(selected('android','0').has('@elizaos/plugin-workflow')).toBe(false);
 const plugins=selected('android','1');expect(plugins.has('@elizaos/plugin-workflow')).toBe(true);
 for(const name of ['coding-tools','agent-orchestrator','gitpathologist','pty','wallet'])expect(plugins.has('@elizaos/plugin-'+name)).toBe(false);
});
test('iOS exclusion and explicit workflow disable remain effective',()=>{
 expect(selected('ios','1').has('@elizaos/plugin-workflow')).toBe(false);
 expect(selected('android','1',{workflow:{enabled:false}}).has('@elizaos/plugin-workflow')).toBe(false);
 expect(selected('android','1',{plugins:{entries:{workflow:{enabled:false}}}}).has('@elizaos/plugin-workflow')).toBe(false);
});
