import { getScraper } from './test-utils';

test('scraper can get profile followers', async () => {
  const scraper = await getScraper();

  const seenProfiles = new Map<string, boolean>();
  const maxProfiles = 50;
  let nProfiles = 0;

  const profiles = await scraper.getFollowers(
    '1425600122885394432',
    maxProfiles,
  );

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

test('scraper can get profile following', async () => {
  const scraper = await getScraper();

  const seenProfiles = new Map<string, boolean>();
  const maxProfiles = 50;
  let nProfiles = 0;

  const profiles = await scraper.getFollowing(
    '1425600122885394432',
    maxProfiles,
  );

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
