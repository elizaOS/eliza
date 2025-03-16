import { getClient } from './test-utils';

test('client can get profile followers', async () => {
  const client = await getClient();

  const seenProfiles = new Map<string, boolean>();
  const maxProfiles = 50;
  let nProfiles = 0;

  const profiles = await client.getFollowers('1425600122885394432', maxProfiles);

  for await (const profile of profiles) {
    nProfiles++;

    const id = profile.userId;
    expect(id).toBeTruthy();

    if (id != null) {
      expect(seenProfiles.has(id)).toBeFalsy();
      seenProfiles.set(id, true);
    }

    expect(profile.username).toBeTruthy();
  }

  expect(nProfiles).toEqual(maxProfiles);
});

test('client can get profile following', async () => {
  const client = await getClient();

  const seenProfiles = new Map<string, boolean>();
  const maxProfiles = 50;
  let nProfiles = 0;

  const profiles = await client.getFollowing('1425600122885394432', maxProfiles);

  for await (const profile of profiles) {
    nProfiles++;

    const id = profile.userId;
    expect(id).toBeTruthy();

    if (id != null) {
      expect(seenProfiles.has(id)).toBeFalsy();
      seenProfiles.set(id, true);
    }

    expect(profile.username).toBeTruthy();
  }

  expect(nProfiles).toEqual(maxProfiles);
});
