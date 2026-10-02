import { runSmithersWorkflow } from '../../src/services/smithers-runtime';

const request = JSON.parse(process.argv[2]);
await runSmithersWorkflow({
  ...request,
  generate: async () => {
    throw Error('Unexpected parent model call');
  },
});
