import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test';

const startSpanMock = mock(
  async (
    _spanConfig: Record<string, unknown>,
    callback: () => Promise<unknown>
  ) => callback()
);
const setTagMock = mock((_key: string, _value: string) => {});
const setContextMock = mock(
  (_key: string, _value: Record<string, unknown>) => {}
);

let wrapServerActionWithSentry: <T extends unknown[], R>(
  actionName: string,
  action: (...args: T) => Promise<R>
) => (...args: T) => Promise<R>;

describe('wrapServerActionWithSentry', () => {
  beforeAll(async () => {
    mock.module('@sentry/nextjs', () => ({
      startSpan: startSpanMock,
      setTag: setTagMock,
      setContext: setContextMock,
    }));

    ({ wrapServerActionWithSentry } = await import(
      '../../../../apps/web/src/lib/sentry/server-actions'
    ));
  });

  beforeEach(() => {
    startSpanMock.mockClear();
    setTagMock.mockClear();
    setContextMock.mockClear();
  });

  afterAll(() => {
    mock.restore();
  });

  it('returns action result and creates a span on success', async () => {
    const action = mock(async (input: { value: number }) => input.value * 2);
    const wrapped = wrapServerActionWithSentry('doubleValue', action);

    const result = await wrapped({ value: 21 });

    expect(result).toBe(42);
    expect(action).toHaveBeenCalledTimes(1);
    expect(startSpanMock).toHaveBeenCalledTimes(1);

    const firstSpanCall = startSpanMock.mock.calls[0];
    expect(firstSpanCall?.[0]).toMatchObject({
      op: 'server.action',
      name: 'server-action.doubleValue',
    });
    expect(setTagMock).toHaveBeenCalledTimes(0);
  });

  it('enriches scope with action context, rethrows, and does not double-capture', async () => {
    const actionError = new Error('action failed');
    const action = mock(
      async (_input: { token: string; amount: number }, _note: string) => {
        throw actionError;
      }
    );
    const wrapped = wrapServerActionWithSentry('failingAction', action);

    await expect(
      wrapped({ token: 'secret-token', amount: 10 }, 'hello')
    ).rejects.toThrow('action failed');

    expect(startSpanMock).toHaveBeenCalledTimes(1);

    expect(setTagMock).toHaveBeenCalledWith('surface', 'server-action');
    expect(setTagMock).toHaveBeenCalledWith('action', 'failingAction');
    expect(setTagMock).toHaveBeenCalledWith('runtime', 'nodejs');

    const serverActionContextCall = setContextMock.mock.calls.find(
      (call) => call[0] === 'serverAction'
    );
    expect(serverActionContextCall).toBeDefined();
    expect(serverActionContextCall?.[1]).toEqual({
      argCount: 2,
      args: [{ token: '[REDACTED]', amount: 10 }, '[string:5]'],
    });
  });
});
