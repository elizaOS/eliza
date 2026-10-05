import { expect, test } from 'bun:test';
import {
  classifyWindowsLeaseHelperError,
  WindowsLeaseHelperError,
} from '../../src/services/workflow-worker-lease.windows';

test('Windows helper diagnostics expose only closed failure codes', () => {
  const privateText = 'private-path-and-capability-canary';
  const cases = [
    ['error CS1002', 'WINDOWS_LEASE_COMPILE'],
    ['Wrong state SID', 'WINDOWS_LEASE_STATE_OWNER'],
    ['Untrusted existing state ACL', 'WINDOWS_LEASE_STATE_ACL'],
    ['Untrusted owner/ACL', 'WINDOWS_LEASE_PRIVATE_ACL'],
    ['Local drive path required', 'WINDOWS_LEASE_PATH_KIND'],
    ['Canonical path required', 'WINDOWS_LEASE_PATH_CANONICAL'],
    ['Non-directory or reparse ancestor', 'WINDOWS_LEASE_PATH_REPARSE'],
    ['Pin directory ancestor', 'WINDOWS_LEASE_DIRECTORY'],
    ['Helper source hash', 'WINDOWS_LEASE_BOOTSTRAP'],
    ['Source identity mismatch', 'WINDOWS_LEASE_SOURCE_MISMATCH'],
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

// Exact error codes may cross the platform boundary; raw stderr and paths must not.
test('lease inspection preserves fixed native cause while refusing arbitrary error payloads', async () => {
  const { windowsLeaseInspectionFailureReason } = await import(
    '../../src/services/workflow-worker-lease.windows'
  );
  const canary = 'private-path-capability-canary';
  expect(
    windowsLeaseInspectionFailureReason(
      Object.assign(new Error(canary), {
        code: 'WINDOWS_LEASE_PATH_CANONICAL',
      })
    )
  ).toBe('Windows worker helper unavailable (WINDOWS_LEASE_PATH_CANONICAL)');
  for (const error of [
    new Error(canary),
    Object.assign(new Error(canary), { code: canary }),
    { code: 'WINDOWS_LEASE_PATH_KIND', message: canary },
    canary,
    null,
  ]) {
    expect(windowsLeaseInspectionFailureReason(error)).toBe(
      'Windows worker helper unavailable (WINDOWS_LEASE_HELPER_FAILED)'
    );
  }
});

test('owned helper lifecycle classifications survive without exposing transport data', async () => {
  const { windowsLeaseInspectionFailureReason } = await import(
    '../../src/services/workflow-worker-lease.windows'
  );
  for (const code of [
    'WINDOWS_LEASE_STARTUP_DEADLINE',
    'WINDOWS_LEASE_OUTPUT_LIMIT',
    'WINDOWS_LEASE_INVALID_RESPONSE',
    'WINDOWS_LEASE_TRANSPORT',
  ]) {
    expect(
      windowsLeaseInspectionFailureReason(
        Object.assign(new Error('private transport path'), { code })
      )
    ).toBe(`Windows worker helper unavailable (${code})`);
  }
});

test('inspection snapshots changing getters and contains hostile object traps', async () => {
  const { windowsLeaseInspectionFailureReason } = await import(
    '../../src/services/workflow-worker-lease.windows'
  );
  const canary = 'private-path-token-canary';
  let reads = 0;
  const changing = Object.defineProperty(new Error(canary), 'code', {
    get() {
      return ++reads <= 2 ? 'WINDOWS_LEASE_TRANSPORT' : canary;
    },
  });
  expect(windowsLeaseInspectionFailureReason(changing)).toBe(
    'Windows worker helper unavailable (WINDOWS_LEASE_TRANSPORT)'
  );
  expect(reads).toBe(1);
  const throwing = Object.defineProperty(new Error(canary), 'code', {
    get() {
      throw new Error(canary);
    },
  });
  const hasTrap = new Proxy(new Error(canary), {
    has() {
      throw new Error(canary);
    },
  });
  const prototypeTrap = new Proxy(new Error(canary), {
    getPrototypeOf() {
      throw new Error(canary);
    },
  });
  for (const hostile of [throwing, hasTrap, prototypeTrap]) {
    expect(windowsLeaseInspectionFailureReason(hostile)).toBe(
      'Windows worker helper unavailable (WINDOWS_LEASE_HELPER_FAILED)'
    );
  }
});

test('native helper errors retain fixed codes without retaining private diagnostics', () => {
  const error = new WindowsLeaseHelperError(
    'inspect',
    'private-canary\nUntrusted existing state ACL'
  );
  expect(error.code).toBe('WINDOWS_LEASE_STATE_ACL');
  expect(error.message).toBe('Windows lease inspect helper closed (WINDOWS_LEASE_STATE_ACL)');
  expect(JSON.stringify(error)).not.toContain('private-canary');
  expect(error.stack).not.toContain('private-canary');
});
