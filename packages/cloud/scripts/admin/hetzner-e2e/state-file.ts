#!/usr/bin/env bun
/**
 * Persists the manual Hetzner diagnostic's host and agent identities for teardown.
 * Each command adds its result to one state file; atomic replacement prevents
 * an interrupted write from leaving partial JSON.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface HetznerE2EState {
  server_id?: number;
  ip?: string;
  agent_id?: string;
  org_id?: string;
  api_key?: string;
  created_at?: string;
  run_id?: string;
}

export function stateFilePath(): string {
  return process.env.HETZNER_E2E_STATE_FILE ?? "/tmp/hetzner-e2e-state.json";
}

export function readState(): HetznerE2EState {
  const path = stateFilePath();
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as HetznerE2EState;
}

export function appendStateAtomic(
  patch: Partial<HetznerE2EState>,
): HetznerE2EState {
  const path = stateFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const current = readState();
  const next: HetznerE2EState = { ...current, ...patch };
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return next;
}
