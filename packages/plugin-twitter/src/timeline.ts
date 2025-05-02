import type { ClientBase } from './base';
import type { IAgentRuntime } from '@elizaos/core';
import type { Client } from './client/index';

export class TwitterTimelineClient {
  client: ClientBase;
  twitterClient: Client;
  runtime: IAgentRuntime;
  isDryRun: boolean;
  private state: any;

  constructor(client: ClientBase, runtime: IAgentRuntime, state: any) {
    this.client = client;
    this.twitterClient = client.twitterClient;
    this.runtime = runtime;
    this.state = state;
    this.isDryRun =
      this.state?.TWITTER_DRY_RUN ||
      (this.runtime.getSetting('TWITTER_DRY_RUN') as unknown as boolean);
  }

  async start() {
    const handleTwitterTimelineLoop = () => {
      // Defaults to 2 minutes
      const interactionInterval =
        (this.state?.TWITTER_TIMELINE_INTERVAL ||
          (this.runtime.getSetting('TWITTER_TIMELINE_INTERVAL') as unknown as number) ||
          120) * 1000;

      this.handleTimeline();
      setTimeout(handleTwitterTimelineLoop, interactionInterval);
    };
    handleTwitterTimelineLoop();
  }

  async handleTimeline() {
    console.log('Start Hanldeling Twitter Timeline');

    const homeTimeline = await this.twitterClient.fetchHomeTimeline(20, []);
  }
}
