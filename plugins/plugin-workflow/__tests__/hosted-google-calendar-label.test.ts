/**
 * The calendar list is a display projection the owner picks from, so a label
 * cut at the reviewed 200-code-unit cap must not end between the halves of a
 * surrogate pair. A raw `slice(0, 200)` leaves a lone high surrogate that
 * renders as U+FFFD; the boundary must back off instead.
 */
import { describe, expect, test } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import {
  listHostedGoogleCalendars,
  listHostedGoogleSources,
} from '../src/services/hosted-google-source';

const OWNER = 'fixture-owner';
const OWNER_BINDING = {
  id: 'fixture-binding',
  identityId: OWNER,
  connector: 'google',
  externalId: 'synthetic-google-subject',
};
const ACCOUNT = {
  id: 'fixture-google',
  provider: 'google',
  role: 'OWNER',
  purpose: ['reading'],
  accessGate: 'open',
  status: 'connected',
  externalId: 'synthetic-google-subject',
  ownerIdentityId: OWNER,
  ownerBindingId: OWNER_BINDING.id,
  createdAt: 1,
  updatedAt: 1,
  metadata: { grantedCapabilities: ['calendar.read'] },
};

/** Enough of the connector account manager for `getConnectorAccountManager`. */
function runtimeWithSummary(summary: string): IAgentRuntime {
  const manager = {
    registerProvider() {},
    evaluatePolicy() {},
    listAccounts: async () => [ACCOUNT],
    getAccount: async () => ACCOUNT,
  };
  return {
    agentId: 'fixture-agent',
    adapter: { findConnectorOwnerBinding: async () => OWNER_BINDING },
    getService: (name: string) =>
      name === 'google'
        ? {
            listCalendarPage: async () => ({
              calendars: [{ calendarId: 'fixture-calendar', summary, timeZone: 'UTC' }],
            }),
          }
        : manager,
  } as unknown as IAgentRuntime;
}

async function calendarLabel(summary: string): Promise<string> {
  const runtime = runtimeWithSummary(summary);
  const offered = await listHostedGoogleSources(runtime, OWNER);
  const result = await listHostedGoogleCalendars(runtime, OWNER, {
    accountId: ACCOUNT.id,
    accountRevision: offered.accounts[0].accountRevision,
  });
  return result.calendars[0].label;
}

describe('hosted Google calendar labels keep a surrogate pair whole', () => {
  test('a label cut at the 200-code-unit cap does not keep half an emoji', async () => {
    // 199 ASCII units put the emoji's high surrogate at index 199, the last
    // code unit a raw slice(0, 200) keeps.
    const label = await calendarLabel(`${'a'.repeat(199)}\u{1F98A}${'b'.repeat(50)}`);

    expect(label.isWellFormed()).toBe(true);
    expect(label).toBe('a'.repeat(199));
  });

  test('an emoji that fits under the cap is preserved unchanged', async () => {
    const summary = `${'a'.repeat(198)}\u{1F98A}${'b'.repeat(50)}`;

    const label = await calendarLabel(summary);

    expect(label.isWellFormed()).toBe(true);
    expect(label).toBe(summary.slice(0, 200));
  });

  test('a plain ASCII label longer than the cap is unchanged in shape', async () => {
    const label = await calendarLabel('c'.repeat(280));

    expect(label.isWellFormed()).toBe(true);
    expect(label).toBe('c'.repeat(200));
  });
});
