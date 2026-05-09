/**
 * Shared helpers for sandbox route tests.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createMockHttpResponse,
  createMockIncomingMessage,
} from "..//shared";

export function createMockReq(method: string, body?: string): IncomingMessage {
  return createMockIncomingMessage({
    method,
    headers: {},
    body,
  }) as IncomingMessage;
}

export function createMockRes(): ServerResponse & {
  _status: number;
  _body: string;
} {
  const { res } = createMockHttpResponse();
  return res as ServerResponse & {
    _status: number;
    _body: string;
  };
}
