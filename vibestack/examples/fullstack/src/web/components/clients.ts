// States a tab reaches, for the stories (`*.meta.tsx`).
import type { Client } from "../../../gen/client.ts";

/** Online and in step with the server. */
export const synced: Client = {
  confirmed: [{ id: "a-1", title: "milk", done: true, deleted: false }, { id: "a-2", title: "eggs", done: false, deleted: false }],
  seen: 2, pending: [], online: true, made: 2, refusals: 0,
};

/** Offline, with a to-do the server has not heard of, after the server refused an edit. */
export const offline: Client = { ...synced, online: false, made: 3, refusals: 1, pending: [{ seq: 3, op: { tag: "Create", id: "a-3", title: "bread" } }] };
