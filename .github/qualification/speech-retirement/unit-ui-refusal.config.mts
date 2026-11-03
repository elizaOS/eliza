import {mergeConfig} from 'vitest/config';
import base from '/workspace/packages/ui/vitest.config.ts';
const config=mergeConfig(base,{root:'/workspace/packages/ui',cacheDir:'/results/cache/unit-ui-refusal'});
config.test={...config.test,fsModuleCachePath:'/results/cache/unit-ui-refusal/fs-modules',dir:'/workspace/packages/ui',include:["src/hooks/useRealtimeVoiceSession.refusal.test.tsx", "src/voice/voice-session-cloud-budget-rotation.test.ts"],pool:'forks',maxWorkers:1,fileParallelism:false,testTimeout:15000,hookTimeout:20000,execArgv:['--max-old-space-size=1536']};
export default config;
