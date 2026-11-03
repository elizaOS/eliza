import { mergeConfig } from 'vitest/config';
import base from '/workspace/plugins/plugin-assistant/vitest.config.ts';
export default mergeConfig(base,{root:'/workspace/plugins/plugin-assistant',cacheDir:'/results/cache/normal-3',test:{include:["src/__tests__/stage1/response-format.test.ts", "src/runtime/calendar-read-coverage.test.ts", "src/services/message/reply-quality.verbatim.test.ts"],pool:'forks',maxWorkers:1,fileParallelism:false,testTimeout:15000,hookTimeout:20000}});
