/** Verifies that successful embedded workflow registration remains debug-only startup diagnostics. */
import { expect, spyOn, test } from 'bun:test';
import { type IAgentRuntime, logger } from '@elizaos/core';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';

test('successful lazy registration logs at debug instead of info', async () => {
  const debugSpy = spyOn(logger, 'debug').mockImplementation(() => undefined);
  const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined);

  try {
    const runtime = {
      agentId: 'startup-log-test',
      character: { settings: {} },
      getSetting: () => null,
      getService: () => null,
      getTasks: async () => [],
      reportError: () => {},
    } as unknown as IAgentRuntime;

    const service = await EmbeddedWorkflowService.start(runtime);

    expect(debugSpy).toHaveBeenCalledWith(
      { src: 'plugin:workflow:embedded' },
      'Embedded workflow service registered (lazy runtime load)'
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      { src: 'plugin:workflow:embedded' },
      'Embedded workflow service registered (lazy runtime load)'
    );
    await service.stop();
  } finally {
    debugSpy.mockRestore();
    infoSpy.mockRestore();
  }
});
