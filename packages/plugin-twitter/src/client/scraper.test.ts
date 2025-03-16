import { Client } from './client';
import { getClient } from './test-utils';

test('client can fetch home timeline', async () => {
  const client = await getClient();

  const count = 20;
  const seenTweetIds: string[] = [];

  const homeTimeline = await client.fetchHomeTimeline(count, seenTweetIds);
  console.log(homeTimeline);
  expect(homeTimeline).toBeDefined();
  expect(homeTimeline?.length).toBeGreaterThan(0);
  expect(homeTimeline[0]?.rest_id).toBeDefined();
}, 30000);

test('client can fetch following timeline', async () => {
  const client = await getClient();

  const count = 20;
  const seenTweetIds: string[] = [];

  const homeTimeline = await client.fetchFollowingTimeline(count, seenTweetIds);
  console.log(homeTimeline);
  expect(homeTimeline).toBeDefined();
  expect(homeTimeline?.length).toBeGreaterThan(0);
  expect(homeTimeline[0]?.rest_id).toBeDefined();
}, 30000);

test('client uses response transform when provided', async () => {
  const client = new Client({
    transform: {
      response: (response) =>
        new Proxy(response, {
          get(target, p, receiver) {
            if (p === 'status') {
              return 400;
            }

            if (p === 'ok') {
              return false;
            }

            return Reflect.get(target, p, receiver);
          },
        }),
    },
  });

  await expect(client.getLatestTweet('twitter')).rejects.toThrow();
});
