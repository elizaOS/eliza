import {mergeConfig} from 'vitest/config';
import base from '/workspace/packages/host/vitest.config.ts';
const config=mergeConfig(base,{root:'/workspace/packages/host',cacheDir:'/results/cache/unit-host-voice'});
config.test={...config.test,dir:'/workspace/packages/host',include:["src/voice/cloud-speech-relay-client.test.ts", "src/voice/cloud-speech-relay-http-status.test.ts", "src/voice/cloud-speech-relay-phase-deadline.test.ts", "src/voice/cloud-speech-relay-startup-deadline.test.ts", "src/voice/cloud-speech-retirement-recovery.test.ts", "src/voice/speech-no-dispatch-proof.test.ts", "src/voice/speech-retirement-proof.test.ts", "src/voice/voice-stop-intent.test.ts"],pool:'forks',maxWorkers:1,fileParallelism:false,testTimeout:15000,hookTimeout:20000,execArgv:['--max-old-space-size=1536']};
export default config;
