import { findUserByIdentifierWithSelect } from '@feed/api';
import { users } from '@feed/db';
import { loadActorsData } from '@feed/engine';
import { extractUsername } from '@feed/shared';
import { notFound, redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

function equalsLoose(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export default async function LegacyProfileIdPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const identifier = decodeURIComponent(id);

  const user = (await findUserByIdentifierWithSelect(identifier, {
    id: users.id,
    username: users.username,
    isActor: users.isActor,
  })) as { id: string; username: string | null; isActor: boolean } | null;

  if (user && user.isActor !== true) {
    if (user.username) {
      const handle = extractUsername(user.username);
      redirect(`/u/${encodeURIComponent(handle)}`);
    }
    redirect(`/u/id/${encodeURIComponent(user.id)}`);
  }

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
    redirect(`/orgs/${encodeURIComponent(org.id)}`);
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
    redirect(`/actors/${encodeURIComponent(actor.id)}`);
  }

  if (user && user.isActor === true) {
    redirect(`/actors/${encodeURIComponent(user.id)}`);
  }

  notFound();
}
