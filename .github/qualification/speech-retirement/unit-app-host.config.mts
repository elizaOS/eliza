import {mergeConfig} from 'vitest/config';
import base from '/workspace/packages/app/vitest.host.config.ts';
const config=mergeConfig(base,{root:'/workspace/packages/app',cacheDir:'/results/cache/unit-app-host'});
config.test={...config.test,dir:'/workspace/packages/app',include:["src/api/self-hosted-voice.test.ts"],pool:'forks',maxWorkers:1,fileParallelism:false,testTimeout:15000,hookTimeout:20000,execArgv:['--max-old-space-size=1536']};
export default config;
