import { type Action } from '@elizaos/core';
import { extractTrainingDataAction } from './extract-training-data.js';
import { startTrainingAction } from './start-training.js';
import { monitorTrainingAction } from './monitor-training.js';

/**
 * All training plugin actions
 */
export const trainingActions: Action[] = [
  extractTrainingDataAction,
  startTrainingAction,
  monitorTrainingAction,
];

export { extractTrainingDataAction, startTrainingAction, monitorTrainingAction };
