import messageFlowTestSuite from './message-flow';
import actionsTestSuite from './actions';
import providersTestSuite from './providers';
import settingsTestSuite from './settings';
import roomStateTestSuite from './room-state';

// Export all test suites for the plugin
export const testSuites = [
  messageFlowTestSuite,
  actionsTestSuite,
  providersTestSuite,
  settingsTestSuite,
  roomStateTestSuite,
];

// Also export individually for direct access
export {
  messageFlowTestSuite,
  actionsTestSuite,
  providersTestSuite,
  settingsTestSuite,
  roomStateTestSuite,
};

export default testSuites;
