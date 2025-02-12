import { getScraper } from './test-utils';

const testLogin = process.env['TWITTER_PASSWORD'] ? test : test.skip;

testLogin(
  'scraper can log in',
  async () => {
    const scraper = await getScraper({ authMethod: 'password' });
    await expect(scraper.isLoggedIn()).resolves.toBeTruthy();
  },
  15000,
);

test('scraper can log in with cookies', async () => {
  const scraper = await getScraper();
  await expect(scraper.isLoggedIn()).resolves.toBeTruthy();
});

test('scraper can restore its login state from cookies', async () => {
  const scraper = await getScraper();
  await expect(scraper.isLoggedIn()).resolves.toBeTruthy();
  const scraper2 = await getScraper({ authMethod: 'anonymous' });
  await expect(scraper2.isLoggedIn()).resolves.toBeFalsy();

  const cookies = await scraper.getCookies();
  await scraper2.setCookies(cookies);

  await expect(scraper2.isLoggedIn()).resolves.toBeTruthy();
});

testLogin(
  'scraper can log out',
  async () => {
    const scraper = await getScraper({ authMethod: 'password' });
    await expect(scraper.isLoggedIn()).resolves.toBeTruthy();

    await scraper.logout();

    await expect(scraper.isLoggedIn()).resolves.toBeFalsy();
  },
  15000,
);
