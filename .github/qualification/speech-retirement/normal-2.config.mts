import { mergeConfig } from 'vitest/config';
import base from '/workspace/packages/ui/vitest.config.ts';
export default mergeConfig(base,{root:'/workspace/packages/ui',cacheDir:'/results/cache/normal-2',test:{include:["src/hooks/useRealtimeVoiceSession.refusal.test.tsx", "src/voice/voice-session-cloud-budget-rotation.test.ts"],pool:'forks',maxWorkers:1,fileParallelism:false,testTimeout:15000,hookTimeout:20000}});
