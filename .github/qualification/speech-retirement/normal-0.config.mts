import { mergeConfig } from 'vitest/config';
import base from '/workspace/packages/host/vitest.config.ts';
export default mergeConfig(base,{root:'/workspace/packages/host',cacheDir:'/results/cache/normal-0',test:{include:["src/voice/cartesia-sonic-retirement.test.ts", "src/voice/speech-relay-session.test.ts", "src/voice/speech-retirement-session.test.ts"],pool:'forks',maxWorkers:1,fileParallelism:false,testTimeout:15000,hookTimeout:20000}});
