/**
 * Profile Identifier Resolution API
 *
 * @route GET /api/profiles/resolve/[identifier]
 * @access Public
 *
 * @description
 * Resolves an ambiguous identifier (user ID, username, Privy DID, actor name,
 * org name) to a canonical profile path. Used by the mobile app to replicate
 * the server-side resolution logic from profile/[id]/page.tsx without importing
 * server-only packages.
 *
 * Returns:
 * - `{ redirect: '/u/handle' }` — User found by username
 * - `{ redirect: '/u/id/userId' }` — User found by ID
 * - `{ redirect: '/actors/actorId' }` — Actor/NPC found
 * - `{ redirect: '/orgs/orgId' }` — Organization found
 * - 404 — No matching entity
 */

import {
  findUserByIdentifierWithSelect,
  withErrorHandling,
} from '@babylon/api';
import { users } from '@babylon/db';
import { loadActorsData } from '@babylon/engine';
import { extractUsername } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

function equalsLoose(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export const GET = withErrorHandling(
  async (
    _request: NextRequest,
    context: { params: Promise<{ identifier: string }> }
  ) => {
    const { identifier: rawIdentifier } = await context.params;
    const identifier = decodeURIComponent(rawIdentifier);

    // Check if it's a user
    const user = (await findUserByIdentifierWithSelect(identifier, {
      id: users.id,
      username: users.username,
      isActor: users.isActor,
    })) as { id: string; username: string | null; isActor: boolean } | null;

    if (user && user.isActor !== true) {
      if (user.username) {
        const handle = extractUsername(user.username);
        return NextResponse.json({
          redirect: `/u/${encodeURIComponent(handle)}`,
        });
      }
      return NextResponse.json({
        redirect: `/u/id/${encodeURIComponent(user.id)}`,
      });
    }

    // Check actors and organizations
    const { actors, organizations } = loadActorsData();
    const idLower = identifier.toLowerCase();

    const org =
      organizations?.find((o) => o.id === identifier) ||
      organizations?.find((o) => equalsLoose(o.name, identifier)) ||
      organizations?.find(
        (o) =>
          (o as { username?: string }).username &&
          equalsLoose((o as { username: string }).username, identifier)
      );

    if (org) {
      return NextResponse.json({
        redirect: `/orgs/${encodeURIComponent(org.id)}`,
      });
    }

    const actor =
      actors?.find((a) => a.id === identifier) ||
      actors?.find(
        (a) =>
          (a as { username?: string }).username &&
          equalsLoose((a as { username: string }).username, identifier)
      ) ||
      actors?.find((a) => a.name.toLowerCase() === idLower);

    if (actor) {
      return NextResponse.json({
        redirect: `/actors/${encodeURIComponent(actor.id)}`,
      });
    }

    // User is an actor (isActor flag)
    if (user && user.isActor === true) {
      return NextResponse.json({
        redirect: `/actors/${encodeURIComponent(user.id)}`,
      });
    }

    return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
  }
);
