/**
 * CRL Agent Identity Map
 *
 * @route GET /api/crl/identity-map
 *
 * Returns the red/blue/gray team assignments for all agents.
 * Used by the Nebius CRL trainer to understand ground-truth labels.
 */

import { withErrorHandling } from '@babylon/api';
import { db, eq, userAgentConfigs, users } from '@babylon/db';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async function GET() {
  try {
    // Fetch all agent configs with team/alignment info
    const configs = await db
      .select({
        userId: userAgentConfigs.userId,
        team: userAgentConfigs.team,
        alignment: userAgentConfigs.alignment,
        username: users.username,
        displayName: users.displayName,
      })
      .from(userAgentConfigs)
      .leftJoin(users, eq(users.id, userAgentConfigs.userId));

    const identityMap: Record<
      string,
      { team: string; alignment: string; name: string }
    > = {};

    for (const config of configs) {
      identityMap[config.userId] = {
        team: config.team || 'gray',
        alignment: config.alignment || 'neutral',
        name: config.displayName || config.username || config.userId,
      };
    }

    return NextResponse.json({
      identityMap,
      counts: {
        red: Object.values(identityMap).filter((a) => a.team === 'red').length,
        blue: Object.values(identityMap).filter((a) => a.team === 'blue')
          .length,
        gray: Object.values(identityMap).filter((a) => a.team === 'gray')
          .length,
        total: Object.keys(identityMap).length,
      },
    });
  } catch (_error) {
    return NextResponse.json(
      { error: 'Failed to fetch identity map' },
      { status: 500 }
    );
  }
});
