import { expect, test } from 'bun:test';
import { checkWorkflowSource } from '../../src/services/workflow-source-check';

test('real compiler accepts Smithers workflow and rejects scalar/function default exports without execution', async () => {
  const canonical =
    '/** @jsxImportSource smthrs */\nimport { createSmithers } from "smthrs/create";\nimport { approvalDecisionSchema } from "smthrs";\nimport { z } from "zod";\n\nconst { Workflow, Sequence, Approval, Task, smithers, outputs } = createSmithers(\n  { decision: approvalDecisionSchema, output: z.object({ value: z.number() }) },\n  { dbPath: process.env.ELIZA_SMTHRS_DB_PATH },\n);\nexport default smithers(() => (\n  <Workflow name="synthetic-arithmetic">\n    <Sequence>\n      <Approval id="review" output={outputs.decision} request={{\n        title: "Calculate?", summary: "Produce synthetic arithmetic after review.",\n        metadata: { approvalPresentation: {\n          version: 1, operation: "Compute", target: "Synthetic result", account: "Fixture owner",\n        } },\n      }} />\n      <Task id="arithmetic" output={outputs.output}>{{ value: 56 }}</Task>\n    </Sequence>\n  </Workflow>\n));\n';
  const approveCanonical = canonical.replace(
    'id="review" output=',
    'id="review" mode="approve" output='
  );
  expect(await checkWorkflowSource(approveCanonical)).toEqual([]);
  const modelTask = approveCanonical.replace(
    'id="arithmetic" output=',
    'id="arithmetic" agent={globalThis.__elizaSmithers.agent} retries={2} output='
  );
  expect(await checkWorkflowSource(modelTask)).toEqual([]);
  const invalidGate = approveCanonical.replace('mode="approve"', 'mode="gate"');
  expect((await checkWorkflowSource(invalidGate)).some((item) => item.includes('TS2322'))).toBe(
    true
  );
  for (const value of ['42', '() => 42']) {
    const diagnostics = await checkWorkflowSource(
      'import {createSmithers} from "smthrs/create"; export default ' + value + ';'
    );
    expect(
      diagnostics.some((item) => item.includes('TS2322') && item.includes('SmithersWorkflow'))
    ).toBe(true);
  }
}, 120000);
