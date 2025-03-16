import { getClient } from './test-utils';

test('client can get trends', async () => {
  const client = await getClient();
  const trends = await client.getTrends();
  expect(trends).toHaveLength(20);
  trends.forEach((trend) => expect(trend).not.toBeFalsy());
}, 15000);
