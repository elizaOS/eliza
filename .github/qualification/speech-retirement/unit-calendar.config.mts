import {mergeConfig} from 'vitest/config';
import base from '/workspace/plugins/plugin-assistant/vitest.config.ts';
const config=mergeConfig(base,{root:'/workspace/plugins/plugin-assistant',cacheDir:'/results/cache/unit-calendar'});
config.test={...config.test,dir:'/workspace/plugins/plugin-assistant',include:["src/runtime/calendar-read-coverage.test.ts"],pool:'forks',maxWorkers:1,fileParallelism:false,testTimeout:15000,hookTimeout:20000,execArgv:['--max-old-space-size=1536']};
export default config;
