/** Unit tests for active-chat-host resolution and fan-out — pure state, no shell. */
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_CHAT_HOST_MESSAGE,
  ActiveChatHostBroadcaster,
  resolveActiveChatHostWindowId,
} from "./desktop-chat-host";

describe("resolveActiveChatHostWindowId", () => {
  it("hosts on the focused surface when it is the chat window and the app is active", () => {
    expect(
      resolveActiveChatHostWindowId({
        mainWindowId: 1,
        focusedSurfaceWindowId: 2,
        focusedSurfaceIsChatCapable: true,
        appActive: true,
      }),
    ).toBe(2);
  });

  it("stays on main when the focused surface is not the chat window", () => {
    expect(
      resolveActiveChatHostWindowId({
        mainWindowId: 1,
        focusedSurfaceWindowId: 2,
        focusedSurfaceIsChatCapable: false,
        appActive: true,
      }),
    ).toBe(1);
  });

  it("falls back to main when a chat surface is focused but the app is inactive", () => {
    expect(
      resolveActiveChatHostWindowId({
        mainWindowId: 1,
        focusedSurfaceWindowId: 2,
        focusedSurfaceIsChatCapable: true,
        appActive: false,
      }),
    ).toBe(1);
  });

  it("hosts on main when no surface is focused", () => {
    expect(
      resolveActiveChatHostWindowId({
        mainWindowId: 1,
        focusedSurfaceWindowId: null,
        focusedSurfaceIsChatCapable: false,
        appActive: true,
      }),
    ).toBe(1);
  });

  it("returns null only when there is no main window at all", () => {
    expect(
      resolveActiveChatHostWindowId({
        mainWindowId: null,
        focusedSurfaceWindowId: null,
        focusedSurfaceIsChatCapable: false,
        appActive: true,
      }),
    ).toBeNull();
  });
});

describe("ActiveChatHostBroadcaster", () => {
  it("broadcasts the host only when it changes, to every registered window", () => {
    const broadcaster = new ActiveChatHostBroadcaster();
    const mainSend = vi.fn();
    const chatSend = vi.fn();

    broadcaster.setMainWindow(1, mainSend);
    broadcaster.registerWindow(2, chatSend, true);

    // Focusing the chat surface makes it the host — both windows are told.
    broadcaster.setFocusedSurface(2);
    broadcaster.broadcastActiveChatHost();
    expect(mainSend).toHaveBeenCalledWith(ACTIVE_CHAT_HOST_MESSAGE, {
      hostWindowId: 2,
    });
    expect(chatSend).toHaveBeenCalledWith(ACTIVE_CHAT_HOST_MESSAGE, {
      hostWindowId: 2,
    });

    // Re-broadcasting the same host is a no-op (change-dedup).
    mainSend.mockClear();
    chatSend.mockClear();
    broadcaster.broadcastActiveChatHost();
    expect(mainSend).not.toHaveBeenCalled();
    expect(chatSend).not.toHaveBeenCalled();
  });

  it("keeps the host on main when a focused surface is not chat-capable", () => {
    const broadcaster = new ActiveChatHostBroadcaster();
    const mainSend = vi.fn();
    const docsSend = vi.fn();

    broadcaster.setMainWindow(1, mainSend);
    // A documents/character/etc. window: registered, but NOT chat-capable.
    broadcaster.registerWindow(2, docsSend, false);

    // Baseline: the main pill is the host and everyone is told so.
    broadcaster.broadcastActiveChatHost();
    expect(broadcaster.getActiveChatHostWindowId()).toBe(1);
    mainSend.mockClear();
    docsSend.mockClear();

    // Focusing a non-chat surface must NOT hand it the host — the pill stays.
    broadcaster.setFocusedSurface(2);
    broadcaster.broadcastActiveChatHost();
    expect(broadcaster.getActiveChatHostWindowId()).toBe(1);
    // Host is unchanged, so there is no new broadcast (and nobody heard "2").
    expect(mainSend).not.toHaveBeenCalled();
    expect(docsSend).not.toHaveBeenCalled();
  });

  it("hands off to the chat window and back to main across chat/non-chat focus", () => {
    const broadcaster = new ActiveChatHostBroadcaster();
    const mainSend = vi.fn();
    const chatSend = vi.fn();
    const docsSend = vi.fn();

    broadcaster.setMainWindow(1, mainSend);
    broadcaster.registerWindow(2, chatSend, true);
    broadcaster.registerWindow(3, docsSend, false);

    // Chat window focused -> host is the chat window.
    broadcaster.setFocusedSurface(2);
    broadcaster.broadcastActiveChatHost();
    expect(broadcaster.getActiveChatHostWindowId()).toBe(2);

    mainSend.mockClear();
    chatSend.mockClear();
    docsSend.mockClear();

    // Documents window focused -> host falls back to the main pill.
    broadcaster.setFocusedSurface(3);
    broadcaster.broadcastActiveChatHost();
    expect(broadcaster.getActiveChatHostWindowId()).toBe(1);
    expect(mainSend).toHaveBeenCalledWith(ACTIVE_CHAT_HOST_MESSAGE, {
      hostWindowId: 1,
    });
    expect(chatSend).toHaveBeenCalledWith(ACTIVE_CHAT_HOST_MESSAGE, {
      hostWindowId: 1,
    });
  });

  it("falls back to main when the host chat surface closes", () => {
    const broadcaster = new ActiveChatHostBroadcaster();
    const mainSend = vi.fn();
    const chatSend = vi.fn();

    broadcaster.setMainWindow(1, mainSend);
    broadcaster.registerWindow(2, chatSend, true);
    broadcaster.setFocusedSurface(2);
    broadcaster.broadcastActiveChatHost();
    expect(broadcaster.getActiveChatHostWindowId()).toBe(2);

    mainSend.mockClear();
    chatSend.mockClear();

    // Closing the focused chat surface drops it and clears its focus role.
    broadcaster.unregisterWindow(2);
    broadcaster.broadcastActiveChatHost();

    expect(broadcaster.getActiveChatHostWindowId()).toBe(1);
    expect(mainSend).toHaveBeenCalledWith(ACTIVE_CHAT_HOST_MESSAGE, {
      hostWindowId: 1,
    });
    // The closed window is no longer in the broadcast set.
    expect(chatSend).not.toHaveBeenCalled();
  });

  it("falls back to main when the app goes inactive while the chat surface is focused", () => {
    const broadcaster = new ActiveChatHostBroadcaster();
    const mainSend = vi.fn();
    const chatSend = vi.fn();

    broadcaster.setMainWindow(1, mainSend);
    broadcaster.registerWindow(2, chatSend, true);
    broadcaster.setFocusedSurface(2);
    broadcaster.broadcastActiveChatHost();
    expect(broadcaster.getActiveChatHostWindowId()).toBe(2);

    broadcaster.setAppActive(false);
    broadcaster.broadcastActiveChatHost();
    expect(broadcaster.getActiveChatHostWindowId()).toBe(1);

    // App refocuses on the still-focused chat surface: host returns to it.
    broadcaster.setAppActive(true);
    broadcaster.broadcastActiveChatHost();
    expect(broadcaster.getActiveChatHostWindowId()).toBe(2);
  });

  it("sends the current host to a single late-joining window", () => {
    const broadcaster = new ActiveChatHostBroadcaster();
    const mainSend = vi.fn();
    const lateSend = vi.fn();

    broadcaster.setMainWindow(1, mainSend);
    broadcaster.registerWindow(3, lateSend, false);

    broadcaster.sendCurrentHostToWindow(3);
    expect(lateSend).toHaveBeenCalledWith(ACTIVE_CHAT_HOST_MESSAGE, {
      hostWindowId: 1,
    });
    // Catch-up is targeted: it does not touch other windows.
    expect(mainSend).not.toHaveBeenCalled();
  });
});
