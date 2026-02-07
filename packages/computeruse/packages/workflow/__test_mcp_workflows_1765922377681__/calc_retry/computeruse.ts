import { createWorkflow, createStep, z } from '@mediar-ai/workflow';

let clickAttempts = 0;

export default createWorkflow({
  name: 'Calculator Retry Test',
  input: z.object({}),
  steps: [
    createStep({
      id: 'open_calc',
      name: 'Open Calculator',
      execute: async ({ desktop }) => {
        await desktop.openApplication('calc');
        await desktop.delay(2000);
        return { state: { opened: true } };
      },
    }),
    createStep({
      id: 'click_with_retry',
      name: 'Click with Retry',
      execute: async ({ desktop }) => {
        clickAttempts++;
        console.log(`Attempt ${clickAttempts}`);

        // Fail first attempt
        if (clickAttempts === 1) {
          throw new Error('Simulated failure on first attempt');
        }

        const one = await desktop.locator('name:Calculator >> name:One').first(3000);
        await one.click();
        await desktop.delay(500);
        return { state: { clicked: true, attempts: clickAttempts } };
      },
      onError: async ({ retry, logger }) => {
        logger.info(`Retrying after failure (attempt ${clickAttempts})`);
        if (clickAttempts < 3) {
          await retry();
          return;
        }
        throw new Error('Max retries exceeded');
      },
    }),
  ],
});