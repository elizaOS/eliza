import { mergeConfig } from 'vitest/config';
import base from '/workspace/packages/app/vitest.host.config.ts';
export default mergeConfig(base,{root:'/workspace/packages/app',cacheDir:'/results/cache/normal-0',test:{include:["src/api/self-hosted-voice.test.ts"],pool:'forks',maxWorkers:1,fileParallelism:false,testTimeout:15000,hookTimeout:20000}});
