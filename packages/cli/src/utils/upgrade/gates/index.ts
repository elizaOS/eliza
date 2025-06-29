import { GateConfig } from '../types';
import { gate0Branch } from './gate-0-branch';
import { gate1Analysis } from './gate-1-analysis';
import { gate2Setup } from './gate-2-setup';
import { gate3Build } from './gate-3-build';
import { gate4TypeScript } from './gate-4-typescript';
import { gate5Migration } from './gate-5-migration';
import { gate6Tests } from './gate-6-tests';
import { gate7Final } from './gate-7-final';
import { gate8Verify } from './gate-8-verify';

export function getAllGates(): GateConfig[] {
  return [
    gate0Branch,
    gate1Analysis,
    gate2Setup,
    gate3Build,
    gate4TypeScript,
    gate5Migration,
    gate6Tests,
    gate7Final,
    gate8Verify,
  ];
}

export {
  gate0Branch,
  gate1Analysis,
  gate2Setup,
  gate3Build,
  gate4TypeScript,
  gate5Migration,
  gate6Tests,
  gate7Final,
  gate8Verify,
};
