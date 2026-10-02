import { expect, test } from 'bun:test';
import { classifyWindowsLeaseHelperError } from '../../src/services/workflow-worker-lease.windows';

test('Windows helper diagnostics expose only closed failure codes', () => {
  const privateText = 'private-path-and-capability-canary';
  const cases = [
    ['error CS1002', 'WINDOWS_LEASE_COMPILE'],
    ['Wrong state SID', 'WINDOWS_LEASE_STATE_OWNER'],
    ['Untrusted existing state ACL', 'WINDOWS_LEASE_STATE_ACL'],
    ['Untrusted owner/ACL', 'WINDOWS_LEASE_PRIVATE_ACL'],
    ['Non-directory or reparse ancestor', 'WINDOWS_LEASE_PATH'],
    ['Pin directory ancestor', 'WINDOWS_LEASE_DIRECTORY'],
    ['Helper source hash', 'WINDOWS_LEASE_BOOTSTRAP'],
    ['CREATE_NEW private file', 'WINDOWS_LEASE_RESERVATION'],
    ['Process identity', 'WINDOWS_LEASE_WORKER'],
    [privateText, 'WINDOWS_LEASE_HELPER_FAILED'],
  ];
  for (const [message, expected] of cases) {
    const code = classifyWindowsLeaseHelperError(`${privateText}\n${message}\n${privateText}`);
    expect(code).toBe(expected);
    expect(code).not.toContain(privateText);
  }
});
