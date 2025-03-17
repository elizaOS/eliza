import { getClient } from './test-utils';

const testLogin = process.env.TWITTER_PASSWORD ? test : test.skip;

testLogin(
  'client can log in',
  async () => {
    const client = await getClient({ authMethod: 'password' });
    await expect(client.isLoggedIn()).resolves.toBeTruthy();
  },
  15000
);

test('client can log in with cookies', async () => {
  const client = await getClient();
  await expect(client.isLoggedIn()).resolves.toBeTruthy();
});

test('client can restore its login state from cookies', async () => {
  const client = await getClient();
  await expect(client.isLoggedIn()).resolves.toBeTruthy();
  const client2 = await getClient({ authMethod: 'anonymous' });
  await expect(client2.isLoggedIn()).resolves.toBeFalsy();

  const cookies = await client.getCookies();
  await client2.setCookies(cookies);

  await expect(client2.isLoggedIn()).resolves.toBeTruthy();
});

testLogin(
  'client can log out',
  async () => {
    const client = await getClient({ authMethod: 'password' });
    await expect(client.isLoggedIn()).resolves.toBeTruthy();

    await client.logout();

    await expect(client.isLoggedIn()).resolves.toBeFalsy();
  },
  15000
);
