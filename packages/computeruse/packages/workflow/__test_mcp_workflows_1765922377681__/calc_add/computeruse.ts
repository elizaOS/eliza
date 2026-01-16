import { createWorkflow, createStep, z } from '@mediar-ai/workflow';

export default createWorkflow({
  name: 'Calculator Addition Test',
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
      id: 'click_one',
      name: 'Click 1',
      execute: async ({ desktop }) => {
        const one = await desktop.locator('name:Calculator >> name:One').first(3000);
        await one.click();
        await desktop.delay(500);
        return { state: { clicked_one: true } };
      },
    }),
    createStep({
      id: 'click_plus',
      name: 'Click Plus',
      execute: async ({ desktop }) => {
        const plus = await desktop.locator('name:Calculator >> name:Plus').first(3000);
        await plus.click();
        await desktop.delay(500);
        return { state: { clicked_plus: true } };
      },
    }),
    createStep({
      id: 'click_two',
      name: 'Click 2',
      execute: async ({ desktop }) => {
        const two = await desktop.locator('name:Calculator >> name:Two').first(3000);
        await two.click();
        await desktop.delay(500);
        return { state: { clicked_two: true } };
      },
    }),
    createStep({
      id: 'click_equals',
      name: 'Click Equals',
      execute: async ({ desktop }) => {
        const equals = await desktop.locator('name:Calculator >> name:Equals').first(3000);
        await equals.click();
        await desktop.delay(500);
        return { state: { clicked_equals: true } };
      },
    }),
  ],
});