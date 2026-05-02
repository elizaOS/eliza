/**
 * Tests for TelegramOwnerPairingService and the /milady_pair bot command.
 *
 * These tests are unit-level: they use in-process mocks for the backend
 * OWNER_BIND_VERIFY service, the Telegraf bot instance, and IAgentRuntime.
 * No real Telegram bot token or network calls are made.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleMiladyPairCommand,
  TelegramOwnerPairingServiceImpl,
} from '../src/owner-pairing-service';

// --------------------------------------------------------------------------
// Minimal runtime mock
// --------------------------------------------------------------------------

type ServiceMap = Map<string, unknown>;

function makeRuntime(services: ServiceMap = new Map()) {
  return {
    agentId: 'test-agent',
    character: { name: 'TestBot' },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getService: vi.fn((serviceType: string) => services.get(serviceType)),
    getSetting: vi.fn(() => undefined),
    emitEvent: vi.fn().mockResolvedValue(undefined),
  };
}

// --------------------------------------------------------------------------
// Minimal Telegraf context mock
// --------------------------------------------------------------------------

function makeTelegrafCtx(
  userId: number,
  username: string | undefined,
  firstName: string | undefined,
  text: string,
) {
  return {
    from: {
      id: userId,
      username,
      first_name: firstName,
    },
    message: { text },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

// --------------------------------------------------------------------------
// /milady_pair command tests
// --------------------------------------------------------------------------

describe('Telegram /milady_pair command', () => {
  // Reset module-level rate-limit state between tests by re-importing the
  // module. vitest's resetModules() approach is used to ensure a clean slate.
  beforeEach(() => {
    vi.resetModules();
  });

  it('replies with usage hint when no code argument is given', async () => {
    const runtime = makeRuntime();
    const ctx = makeTelegrafCtx(101, 'alice', 'Alice', '/milady_pair');

    await handleMiladyPairCommand(ctx as never, runtime as never);

    expect(ctx.reply).toHaveBeenCalledOnce();
    const msg = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain('Usage');
  });

  it('replies with success when backend returns { success: true }', async () => {
    const verifySvc = {
      verifyOwnerBindFromConnector: vi.fn().mockResolvedValue({ success: true }),
    };
    const services: ServiceMap = new Map([['OWNER_BIND_VERIFY', verifySvc]]);
    const runtime = makeRuntime(services);
    const ctx = makeTelegrafCtx(202, 'bob', 'Bob', '/milady_pair 482193');

    await handleMiladyPairCommand(ctx as never, runtime as never);

    expect(verifySvc.verifyOwnerBindFromConnector).toHaveBeenCalledOnce();
    expect(verifySvc.verifyOwnerBindFromConnector).toHaveBeenCalledWith({
      connector: 'telegram',
      externalId: '202',
      displayHandle: '@bob',
      code: '482193',
    });

    const msg = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toMatch(/paired with milady/i);
  });

  it('replies with failure message when backend returns { success: false }', async () => {
    const verifySvc = {
      verifyOwnerBindFromConnector: vi
        .fn()
        .mockResolvedValue({ success: false, error: 'CODE_EXPIRED' }),
    };
    const services: ServiceMap = new Map([['OWNER_BIND_VERIFY', verifySvc]]);
    const runtime = makeRuntime(services);
    const ctx = makeTelegrafCtx(303, 'carol', 'Carol', '/milady_pair 000000');

    await handleMiladyPairCommand(ctx as never, runtime as never);

    const msg = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toMatch(/invalid or expired/i);
  });

  it('replies with error message when OWNER_BIND_VERIFY service is absent', async () => {
    const runtime = makeRuntime(); // no services
    const ctx = makeTelegrafCtx(404, 'dave', 'Dave', '/milady_pair 123456');

    await handleMiladyPairCommand(ctx as never, runtime as never);

    const msg = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toMatch(/could not reach/i);
  });

  it('enforces per-user rate limit after 5 attempts within one minute', async () => {
    const verifySvc = {
      verifyOwnerBindFromConnector: vi
        .fn()
        .mockResolvedValue({ success: false }),
    };
    const services: ServiceMap = new Map([['OWNER_BIND_VERIFY', verifySvc]]);
    const runtime = makeRuntime(services);

    // 5 attempts — all should reach the backend.
    for (let i = 0; i < 5; i++) {
      const ctx = makeTelegrafCtx(505, 'eve', 'Eve', '/milady_pair 111111');
      await handleMiladyPairCommand(ctx as never, runtime as never);
    }
    expect(verifySvc.verifyOwnerBindFromConnector).toHaveBeenCalledTimes(5);

    // 6th attempt must be blocked.
    const blockedCtx = makeTelegrafCtx(505, 'eve', 'Eve', '/milady_pair 111111');
    await handleMiladyPairCommand(blockedCtx as never, runtime as never);

    const blockedMsg = (blockedCtx.reply as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(blockedMsg).toMatch(/too many/i);
    expect(verifySvc.verifyOwnerBindFromConnector).toHaveBeenCalledTimes(5);
  });
});

// --------------------------------------------------------------------------
// DM-link sender tests
// --------------------------------------------------------------------------

describe('TelegramOwnerPairingService.sendOwnerLoginDmLink', () => {
  it('sends the link via Telegram with expected message body', async () => {
    const sendMessageMock = vi.fn().mockResolvedValue(undefined);
    const telegrafBotMock = {
      command: vi.fn(),
      telegram: { sendMessage: sendMessageMock },
    };
    const telegramSvcMock = { bot: telegrafBotMock };

    const services: ServiceMap = new Map([
      ['telegram', telegramSvcMock],
    ]);
    const runtime = makeRuntime(services);

    const instance = await TelegramOwnerPairingServiceImpl.start(
      runtime as never,
    );

    const link = 'https://milady.local/auth/login?token=xyz987';
    await (
      instance as TelegramOwnerPairingServiceImpl
    ).sendOwnerLoginDmLink({
      externalId: '12345678',
      link,
    });

    expect(sendMessageMock).toHaveBeenCalledOnce();
    const [chatId, messageBody] = (sendMessageMock as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [number, string, unknown];
    expect(chatId).toBe(12345678);
    expect(messageBody).toContain(link);
    expect(messageBody).toContain('Click to log in to Milady');
    expect(messageBody).toContain('expires in 5 minutes');
  });

  it('throws when Telegram bot is not available', async () => {
    const runtime = makeRuntime(); // no telegram service
    const instance = await TelegramOwnerPairingServiceImpl.start(
      runtime as never,
    );

    await expect(
      (instance as TelegramOwnerPairingServiceImpl).sendOwnerLoginDmLink({
        externalId: '999',
        link: 'https://example.com',
      }),
    ).rejects.toThrow(/not available/i);
  });
});
