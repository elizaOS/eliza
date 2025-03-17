// src/utils.ts

import type { EventEmitter } from 'node:events';
import { Headers } from 'headers-polyfill';
import type { ChatClient } from './core/ChatClient';
import type { Logger } from './logger';
import type { BroadcastCreated, TurnServersInfo } from './types';

/**
 * Authorizes a token for guest access, using the provided Periscope cookie.
 * Returns an authorization token (bearer/JWT-like).
 */
/**
 * Authorizes a token for a specified cookie.
 *
 * @param {string} cookie - The cookie to use for authorization.
 * @returns {Promise<string>} The authorized token.
 * @throws {Error} If the request fails or if the authorization_token is missing in the response.
 */
export async function authorizeToken(cookie: string): Promise<string> {
  const headers = new Headers({
    'X-Periscope-User-Agent': 'Twitter/m5',
    'Content-Type': 'application/json',
    'X-Idempotence': Date.now().toString(),
    Referer: 'https://x.com/',
    'X-Attempt': '1',
  });

  const resp = await fetch('https://proxsee.pscp.tv/api/v2/authorizeToken', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      service: 'guest',
      cookie: cookie,
    }),
  });

  if (!resp.ok) {
    throw new Error(`authorizeToken => request failed with status ${resp.status}`);
  }

  const data = (await resp.json()) as { authorization_token: string };
  if (!data.authorization_token) {
    throw new Error('authorizeToken => Missing authorization_token in response');
  }

  return data.authorization_token;
}

/**
 * Publishes a newly created broadcast (Space) to make it live/visible.
 * Generally invoked after creating the broadcast and initializing Janus.
 */
export async function publishBroadcast(params: {
  title: string;
  broadcast: BroadcastCreated;
  cookie: string;
  janusSessionId?: number;
  janusHandleId?: number;
  janusPublisherId?: number;
}): Promise<void> {
  const headers = new Headers({
    'X-Periscope-User-Agent': 'Twitter/m5',
    'Content-Type': 'application/json',
    Referer: 'https://x.com/',
    'X-Idempotence': Date.now().toString(),
    'X-Attempt': '1',
  });

  await fetch('https://proxsee.pscp.tv/api/v2/publishBroadcast', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      accept_guests: true,
      broadcast_id: params.broadcast.room_id,
      webrtc_handle_id: params.janusHandleId,
      webrtc_session_id: params.janusSessionId,
      janus_publisher_id: params.janusPublisherId,
      janus_room_id: params.broadcast.room_id,
      cookie: params.cookie,
      status: params.title,
      conversation_controls: 0,
    }),
  });
}

/**
 * Retrieves TURN server credentials and URIs from Periscope.
 */
export async function getTurnServers(cookie: string): Promise<TurnServersInfo> {
  const headers = new Headers({
    'X-Periscope-User-Agent': 'Twitter/m5',
    'Content-Type': 'application/json',
    Referer: 'https://x.com/',
    'X-Idempotence': Date.now().toString(),
    'X-Attempt': '1',
  });

  const resp = await fetch('https://proxsee.pscp.tv/api/v2/turnServers', {
    method: 'POST',
    headers,
    body: JSON.stringify({ cookie }),
  });
  if (!resp.ok) {
    throw new Error(`getTurnServers => request failed with status ${resp.status}`);
  }
  return resp.json();
}

/**
 * Obtains the region from signer.pscp.tv, typically used when creating a broadcast.
 */
export async function getRegion(): Promise<string> {
  const resp = await fetch('https://signer.pscp.tv/region', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: 'https://x.com',
    },
    body: JSON.stringify({}),
  });
  if (!resp.ok) {
    throw new Error(`getRegion => request failed with status ${resp.status}`);
  }
  const data = (await resp.json()) as { region: string };
  return data.region;
}

/**
 * Creates a new broadcast on Periscope/Twitter.
 * Used by the host to create the underlying audio-room structure.
 */
export async function createBroadcast(params: {
  description?: string;
  languages?: string[];
  cookie: string;
  region: string;
  record: boolean;
}): Promise<BroadcastCreated> {
  const headers = new Headers({
    'X-Periscope-User-Agent': 'Twitter/m5',
    'Content-Type': 'application/json',
    'X-Idempotence': Date.now().toString(),
    Referer: 'https://x.com/',
    'X-Attempt': '1',
  });

  const resp = await fetch('https://proxsee.pscp.tv/api/v2/createBroadcast', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      app_component: 'audio-room',
      content_type: 'visual_audio',
      cookie: params.cookie,
      conversation_controls: 0,
      description: params.description || '',
      height: 1080,
      is_360: false,
      is_space_available_for_replay: params.record,
      is_webrtc: true,
      languages: params.languages ?? [],
      region: params.region,
      width: 1920,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`createBroadcast => request failed with status ${resp.status} ${text}`);
  }

  const data = await resp.json();
  return data as BroadcastCreated;
}

/**
 * Acquires chat access info (token, endpoint, etc.) from Periscope.
 * Needed to connect via WebSocket to the chat server.
 */
export async function accessChat(chatToken: string, cookie: string): Promise<any> {
  const url = 'https://proxsee.pscp.tv/api/v2/accessChat';
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-Periscope-User-Agent': 'Twitter/m5',
  });

  const body = {
    chat_token: chatToken,
    cookie,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`accessChat => request failed with status ${resp.status}`);
  }
  return resp.json();
}

/**
 * Registers this client as a viewer (POST /startWatching), returning a watch session token.
 */
export async function startWatching(lifecycleToken: string, cookie: string): Promise<string> {
  const url = 'https://proxsee.pscp.tv/api/v2/startWatching';
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-Periscope-User-Agent': 'Twitter/m5',
  });

  const body = {
    auto_play: false,
    life_cycle_token: lifecycleToken,
    cookie,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`startWatching => request failed with status ${resp.status}`);
  }
  const json = await resp.json();
  // Typically returns { session: "...someToken..." }
  return json.session;
}

/**
 * Deregisters this client from viewing the broadcast (POST /stopWatching).
 */
export async function stopWatching(session: string, cookie: string): Promise<void> {
  const url = 'https://proxsee.pscp.tv/api/v2/stopWatching';
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-Periscope-User-Agent': 'Twitter/m5',
  });

  const body = { session, cookie };
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`stopWatching => request failed with status ${resp.status}`);
  }
}

/**
 * Optional step: join an existing AudioSpace (POST /audiospace/join).
 * This might be required before you can request speaker.
 */
export async function joinAudioSpace(params: {
  broadcastId: string;
  chatToken: string;
  authToken: string;
  joinAsAdmin?: boolean;
  shouldAutoJoin?: boolean;
}): Promise<any> {
  const url = 'https://guest.pscp.tv/api/v1/audiospace/join';

  const body = {
    ntpForBroadcasterFrame: '2208988800031000000',
    ntpForLiveFrame: '2208988800031000000',
    broadcast_id: params.broadcastId,
    join_as_admin: params.joinAsAdmin ?? false,
    should_auto_join: params.shouldAutoJoin ?? false,
    chat_token: params.chatToken,
  };

  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: params.authToken,
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`joinAudioSpace => request failed with status ${resp.status}`);
  }
  // Typically returns { can_auto_join: boolean } etc.
  return resp.json();
}

/**
 * Submits a speaker request (POST /audiospace/request/submit),
 * returning the session UUID you need for negotiation.
 */
export async function submitSpeakerRequest(params: {
  broadcastId: string;
  chatToken: string;
  authToken: string;
}): Promise<{ session_uuid: string }> {
  const url = 'https://guest.pscp.tv/api/v1/audiospace/request/submit';
  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: params.authToken,
  });

  const body = {
    ntpForBroadcasterFrame: '2208988800030000000',
    ntpForLiveFrame: '2208988800030000000',
    broadcast_id: params.broadcastId,
    chat_token: params.chatToken,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`submitSpeakerRequest => request failed with status ${resp.status}`);
  }
  return resp.json();
}

/**
 * Cancels a previously submitted speaker request (POST /audiospace/request/cancel).
 * Only valid if a request/submit was made first with a sessionUUID.
 */
export async function cancelSpeakerRequest(params: {
  broadcastId: string;
  sessionUUID: string;
  chatToken: string;
  authToken: string;
}): Promise<void> {
  const url = 'https://guest.pscp.tv/api/v1/audiospace/request/cancel';
  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: params.authToken,
  });

  const body = {
    ntpForBroadcasterFrame: '2208988800002000000',
    ntpForLiveFrame: '2208988800002000000',
    broadcast_id: params.broadcastId,
    session_uuid: params.sessionUUID,
    chat_token: params.chatToken,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`cancelSpeakerRequest => request failed with status ${resp.status}`);
  }
  // Typically returns { "success": true }
  return resp.json();
}

/**
 * Negotiates a guest streaming session (POST /audiospace/stream/negotiate),
 * returning a Janus JWT and gateway URL for WebRTC.
 */
export async function negotiateGuestStream(params: {
  broadcastId: string;
  sessionUUID: string;
  authToken: string;
  cookie: string;
}): Promise<{ janus_jwt: string; webrtc_gw_url: string }> {
  const url = 'https://guest.pscp.tv/api/v1/audiospace/stream/negotiate';
  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: params.authToken,
  });

  const body = {
    session_uuid: params.sessionUUID,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`negotiateGuestStream => request failed with status ${resp.status}`);
  }
  return resp.json();
}

/**
 * Mutes a speaker (POST /audiospace/muteSpeaker).
 * If called by the host, sessionUUID is "".
 * If called by a speaker, pass your own sessionUUID.
 */
export async function muteSpeaker(params: {
  broadcastId: string;
  sessionUUID?: string;
  chatToken: string;
  authToken: string;
}): Promise<void> {
  const url = 'https://guest.pscp.tv/api/v1/audiospace/muteSpeaker';

  const body = {
    ntpForBroadcasterFrame: 2208988800031000000,
    ntpForLiveFrame: 2208988800031000000,
    session_uuid: params.sessionUUID ?? '',
    broadcast_id: params.broadcastId,
    chat_token: params.chatToken,
  };

  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: params.authToken,
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`muteSpeaker => ${resp.status} ${text}`);
  }
}

/**
 * Unmutes a speaker (POST /audiospace/unmuteSpeaker).
 * If called by the host, sessionUUID is "".
 * If called by a speaker, pass your own sessionUUID.
 */
export async function unmuteSpeaker(params: {
  broadcastId: string;
  sessionUUID?: string;
  chatToken: string;
  authToken: string;
}): Promise<void> {
  const url = 'https://guest.pscp.tv/api/v1/audiospace/unmuteSpeaker';

  const body = {
    ntpForBroadcasterFrame: 2208988800031000000,
    ntpForLiveFrame: 2208988800031000000,
    session_uuid: params.sessionUUID ?? '',
    broadcast_id: params.broadcastId,
    chat_token: params.chatToken,
  };

  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: params.authToken,
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`unmuteSpeaker => ${resp.status} ${text}`);
  }
}

/**
 * Common chat events helper. Attaches listeners to a ChatClient, then re-emits them
 * through a given EventEmitter (e.g. Space or SpaceParticipant).
 */
export function setupCommonChatEvents(
  chatClient: ChatClient,
  logger: Logger,
  emitter: EventEmitter
): void {
  // Occupancy updates
  chatClient.on('occupancyUpdate', (upd) => {
    logger.debug('[ChatEvents] occupancyUpdate =>', upd);
    emitter.emit('occupancyUpdate', upd);
  });

  // Reaction events
  chatClient.on('guestReaction', (reaction) => {
    logger.debug('[ChatEvents] guestReaction =>', reaction);
    emitter.emit('guestReaction', reaction);
  });

  // Mute state changes
  chatClient.on('muteStateChanged', (evt) => {
    logger.debug('[ChatEvents] muteStateChanged =>', evt);
    emitter.emit('muteStateChanged', evt);
  });

  // Speaker requests
  chatClient.on('speakerRequest', (req) => {
    logger.debug('[ChatEvents] speakerRequest =>', req);
    emitter.emit('speakerRequest', req);
  });

  // Additional event example: new speaker accepted
  chatClient.on('newSpeakerAccepted', (info) => {
    logger.debug('[ChatEvents] newSpeakerAccepted =>', info);
    emitter.emit('newSpeakerAccepted', info);
  });

  chatClient.on('newSpeakerRemoved', (info) => {
    logger.debug('[ChatEvents] newSpeakerRemoved =>', info);
    emitter.emit('newSpeakerRemoved', info);
  });
}
