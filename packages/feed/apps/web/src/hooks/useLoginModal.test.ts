import { beforeEach, describe, expect, it } from 'bun:test';
import { useLoginModal } from './useLoginModal';

describe('useLoginModal', () => {
  beforeEach(() => {
    useLoginModal.setState({
      isOpen: false,
      queuedModal: undefined,
      context: undefined,
      title: undefined,
      message: undefined,
    });
  });

  it('queues a login modal without opening it immediately', () => {
    useLoginModal.getState().queueLoginModal({
      context: 'home',
      title: 'Welcome to Babylon',
      message: 'Log in to continue.',
    });

    expect(useLoginModal.getState().isOpen).toBe(false);
    expect(useLoginModal.getState().queuedModal).toEqual({
      context: 'home',
      title: 'Welcome to Babylon',
      message: 'Log in to continue.',
    });
  });

  it('consumes a queued login modal without affecting the current modal state', () => {
    useLoginModal.getState().queueLoginModal({
      title: 'Queued modal',
    });
    useLoginModal.getState().consumeQueuedLoginModal();

    expect(useLoginModal.getState().queuedModal).toBeUndefined();
    expect(useLoginModal.getState().isOpen).toBe(false);
  });

  it('closes the active modal and clears any queued request', () => {
    useLoginModal.getState().showLoginModal({
      title: 'Open modal',
    });
    useLoginModal.getState().queueLoginModal({
      title: 'Queued modal',
    });

    useLoginModal.getState().closeLoginModal();

    expect(useLoginModal.getState().isOpen).toBe(false);
    expect(useLoginModal.getState().queuedModal).toBeUndefined();
    expect(useLoginModal.getState().title).toBeUndefined();
    expect(useLoginModal.getState().message).toBeUndefined();
  });
});
