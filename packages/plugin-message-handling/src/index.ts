import { type Plugin, PluginEvents } from '@elizaos/core';

import * as actions from './actions/index.ts';
import * as providers from './providers/index.ts';
import { events } from './events';
import { testSuites } from './tests';

export * from './actions/index.ts';
export * from './providers/index.ts';

export const messageHandlingPlugin: Plugin = {
  name: 'message-handling',
  description: 'Agent message handling with basic actions and evaluators',
  actions: [
    actions.replyAction,
    actions.followRoomAction,
    actions.unfollowRoomAction,
    actions.ignoreAction,
    actions.noneAction,
    actions.muteRoomAction,
    actions.unmuteRoomAction,
    actions.updateSettingsAction,
  ],
  // this is jank, these events are not valid
  events: events as any as PluginEvents,
  providers: [
    providers.evaluatorsProvider,
    providers.anxietyProvider,
    providers.timeProvider,
    providers.settingsProvider,
    providers.capabilitiesProvider,
    providers.attachmentsProvider,
    providers.providersProvider,
    providers.actionsProvider,
    providers.actionStateProvider,
    providers.characterProvider,
    providers.recentMessagesProvider,
    providers.worldProvider,
  ],
  tests: testSuites,
  testDependencies: [
    '@elizaos/plugin-sql'
  ]
};

export default messageHandlingPlugin;
