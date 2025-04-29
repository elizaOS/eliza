import fs from 'node:fs';
import path from 'node:path';
import { getClient } from './test-utils';
import type { QueryTweetsResponse } from './timeline-v1';
import { type Mention, type Tweet, getTweetAnonymous } from './tweets';

/**
 * Flag to determine if version 2 tests should be skipped.
 */
let shouldSkipV2Tests = false;
beforeAll(() => {
  const {
    TWITTER_API_KEY,
    TWITTER_API_SECRET_KEY,
    TWITTER_ACCESS_TOKEN,
    TWITTER_ACCESS_TOKEN_SECRET,
  } = process.env;
  if (
    !TWITTER_API_KEY ||
    !TWITTER_API_SECRET_KEY ||
    !TWITTER_ACCESS_TOKEN ||
    !TWITTER_ACCESS_TOKEN_SECRET
  ) {
    console.warn('Skipping tests: Twitter API v2 keys are not available in environment variables.');
    shouldSkipV2Tests = true;
  }
});

test('client can get tweet', async () => {
  const expected: Tweet = {
    conversationId: '1585338303800578049',
    html: `We’re updating Twitter’s sounds to help make them pleasing to more people, including those with sensory sensitivities. Here’s more on how we did it:<br><a href=\"https://blog.twitter.com/en_us/topics/product/2022/designing-accessible-sounds-story-behind-our-new-chirps\">https://t.co/7FKWk7NzHM</a>`,
    id: '1585338303800578049',
    hashtags: [],
    mentions: [],
    name: 'A11y',
    permanentUrl: 'https://twitter.com/XA11y/status/1585338303800578049',
    photos: [],
    text: 'We’re updating Twitter’s sounds to help make them pleasing to more people, including those with sensory sensitivities. Here’s more on how we did it:\nhttps://t.co/7FKWk7NzHM',
    thread: [],
    timeParsed: new Date(Date.UTC(2022, 9, 26, 18, 31, 20, 0)),
    timestamp: 1666809080,
    urls: [
      'https://blog.twitter.com/en_us/topics/product/2022/designing-accessible-sounds-story-behind-our-new-chirps',
    ],
    userId: '1631299117',
    username: 'XA11y',
    videos: [],
    isQuoted: false,
    isReply: false,
    isRetweet: false,
    isPin: false,
    sensitiveContent: false,
  };

  const client = await getClient();
  const actual = await client.getTweet('1585338303800578049');
  delete actual?.likes;
  delete actual?.replies;
  delete actual?.retweets;
  delete actual?.views;
  delete actual?.bookmarkCount;
  expect(actual).toEqual(expected);
});

test('client can get tweets without logging in', async () => {
  const client = await getClient({ authMethod: 'anonymous' });

  let counter = 0;
  for await (const tweet of client.getTweets('elonmusk', 10)) {
    if (tweet) {
      counter++;
    }
  }

  expect(counter).toBeGreaterThanOrEqual(1);
});

test('client can get tweets from list', async () => {
  const client = await getClient();

  let cursor: string | undefined = undefined;
  const maxTweets = 30;
  let nTweets = 0;
  while (nTweets < maxTweets) {
    const res: QueryTweetsResponse = await client.fetchListTweets(
      '1736495155002106192',
      maxTweets,
      cursor
    );

    expect(res.next).toBeTruthy();

    nTweets += res.tweets.length;
    cursor = res.next;
  }
});

test('client can get first tweet matching query', async () => {
  const client = await getClient();

  const timeline = client.getTweets('elonmusk');
  const latestQuote = await client.getTweetWhere(timeline, { isQuoted: true });

  expect(latestQuote?.isQuoted).toBeTruthy();
});

test('client can get all tweets matching query', async () => {
  const client = await getClient();

  // Sample size of 20 should be enough without taking long.
  const timeline = client.getTweets('elonmusk', 20);
  const retweets = await client.getTweetsWhere(timeline, (tweet) => tweet.isRetweet === true);

  expect(retweets).toBeTruthy();

  for (const tweet of retweets) {
    expect(tweet.isRetweet).toBe(true);
  }
}, 20000);

test('client can get latest tweet', async () => {
  const client = await getClient();

  // OLD APPROACH (without retweet filtering)
  const tweets = client.getTweets('elonmusk', 1);
  const expected = (await tweets.next()).value;

  // NEW APPROACH
  const latest = (await client.getLatestTweet('elonmusk', expected?.isRetweet || false)) as Tweet;

  expect(latest?.permanentUrl).toEqual(expected?.permanentUrl);
}, 30000);

test('client can get user mentions in tweets', async () => {
  const expected: Mention[] = [
    {
      id: '7018222',
      username: 'davidmcraney',
      name: 'David McRaney',
    },
  ];

  const client = await getClient();
  const tweet = await client.getTweet('1554522888904101890');
  expect(tweet?.mentions).toEqual(expected);
});

test('client can get tweet quotes without logging in', async () => {
  const expected: Tweet = {
    conversationId: '1237110546383724547',
    html: `The Easiest Problem Everyone Gets Wrong <br><br>[new video] --&gt; <a href=\"https://youtu.be/ytfCdqWhmdg\">https://t.co/YdaeDYmPAU</a> <br><a href=\"https://t.co/iKu4Xs6o2V\"><img src=\"https://pbs.twimg.com/media/ESsZa9AXgAIAYnF.jpg\"/></a>`,
    id: '1237110546383724547',
    hashtags: [],
    mentions: [],
    name: 'Vsauce2',
    permanentUrl: 'https://twitter.com/VsauceTwo/status/1237110546383724547',
    photos: [
      {
        id: '1237110473486729218',
        url: 'https://pbs.twimg.com/media/ESsZa9AXgAIAYnF.jpg',
        alt_text: undefined,
      },
    ],
    text: 'The Easiest Problem Everyone Gets Wrong \n\n[new video] --&gt; https://t.co/YdaeDYmPAU https://t.co/iKu4Xs6o2V',
    thread: [],
    timeParsed: new Date(Date.UTC(2020, 2, 9, 20, 18, 33, 0)),
    timestamp: 1583785113,
    urls: ['https://youtu.be/ytfCdqWhmdg'],
    userId: '978944851',
    username: 'VsauceTwo',
    videos: [],
    isQuoted: false,
    isReply: false,
    isRetweet: false,
    isPin: false,
    sensitiveContent: false,
  };

  const client = await getClient({ authMethod: 'anonymous' });
  const quote = await client.getTweet('1237110897597976576');
  expect(quote?.isQuoted).toBeTruthy();
  delete quote?.quotedStatus?.likes;
  delete quote?.quotedStatus?.replies;
  delete quote?.quotedStatus?.retweets;
  delete quote?.quotedStatus?.views;
  delete quote?.quotedStatus?.bookmarkCount;
  expect(quote?.quotedStatus).toEqual(expected);
});

test('client can get tweet quotes and replies', async () => {
  const expected: Tweet = {
    conversationId: '1237110546383724547',
    html: `The Easiest Problem Everyone Gets Wrong <br><br>[new video] --&gt; <a href=\"https://youtu.be/ytfCdqWhmdg\">https://t.co/YdaeDYmPAU</a> <br><a href=\"https://t.co/iKu4Xs6o2V\"><img src=\"https://pbs.twimg.com/media/ESsZa9AXgAIAYnF.jpg\"/></a>`,
    id: '1237110546383724547',
    hashtags: [],
    mentions: [],
    name: 'Vsauce2',
    permanentUrl: 'https://twitter.com/VsauceTwo/status/1237110546383724547',
    photos: [
      {
        id: '1237110473486729218',
        url: 'https://pbs.twimg.com/media/ESsZa9AXgAIAYnF.jpg',
        alt_text: undefined,
      },
    ],
    text: 'The Easiest Problem Everyone Gets Wrong \n\n[new video] --&gt; https://t.co/YdaeDYmPAU https://t.co/iKu4Xs6o2V',
    thread: [],
    timeParsed: new Date(Date.UTC(2020, 2, 9, 20, 18, 33, 0)),
    timestamp: 1583785113,
    urls: ['https://youtu.be/ytfCdqWhmdg'],
    userId: '978944851',
    username: 'VsauceTwo',
    videos: [],
    isQuoted: false,
    isReply: false,
    isRetweet: false,
    isPin: false,
    sensitiveContent: false,
  };

  const client = await getClient();
  const quote = await client.getTweet('1237110897597976576');
  expect(quote?.isQuoted).toBeTruthy();
  delete quote?.quotedStatus?.likes;
  delete quote?.quotedStatus?.replies;
  delete quote?.quotedStatus?.retweets;
  delete quote?.quotedStatus?.views;
  delete quote?.quotedStatus?.bookmarkCount;
  expect(quote?.quotedStatus).toEqual(expected);

  const reply = await client.getTweet('1237111868445134850');
  expect(reply?.isReply).toBeTruthy();
  if (reply != null) {
    reply.isReply = false;
  }
  delete reply?.inReplyToStatus?.likes;
  delete reply?.inReplyToStatus?.replies;
  delete reply?.inReplyToStatus?.retweets;
  delete reply?.inReplyToStatus?.views;
  delete reply?.inReplyToStatus?.bookmarkCount;
  expect(reply?.inReplyToStatus).toEqual(expected);
});

test('client can get retweet', async () => {
  const expected: Tweet = {
    conversationId: '1776276954435481937',
    html: `<br><a href=\"https://t.co/qqiu5ntffp\"><img src=\"https://pbs.twimg.com/amplify_video_thumb/1776276900580622336/img/UknAtyWSZ286nCD3.jpg\"/></a>`,
    id: '1776276954435481937',
    hashtags: [],
    mentions: [],
    name: 'federico.',
    permanentUrl: 'https://twitter.com/federicosmos/status/1776276954435481937',
    photos: [],
    text: 'https://t.co/qqiu5ntffp',
    thread: [],
    timeParsed: new Date(Date.UTC(2024, 3, 5, 15, 53, 22, 0)),
    timestamp: 1712332402,
    urls: [],
    userId: '2376017065',
    username: 'federicosmos',
    videos: [
      {
        id: '1776276900580622336',
        preview:
          'https://pbs.twimg.com/amplify_video_thumb/1776276900580622336/img/UknAtyWSZ286nCD3.jpg',
        url: 'https://video.twimg.com/amplify_video/1776276900580622336/vid/avc1/640x360/uACt_egp_hmvPOZF.mp4?tag=14',
      },
    ],
    isQuoted: false,
    isReply: false,
    isRetweet: false,
    isPin: false,
    sensitiveContent: false,
  };

  const client = await getClient();
  const retweet = await client.getTweet('1776285549566808397');
  expect(retweet?.isRetweet).toBeTruthy();
  delete retweet?.retweetedStatus?.likes;
  delete retweet?.retweetedStatus?.replies;
  delete retweet?.retweetedStatus?.retweets;
  delete retweet?.retweetedStatus?.views;
  delete retweet?.retweetedStatus?.bookmarkCount;
  expect(retweet?.retweetedStatus).toEqual(expected);
});

test('client can get tweet views', async () => {
  const expected: Tweet = {
    conversationId: '1606055187348688896',
    html: `Replies and likes don’t tell the whole story. We’re making it easier to tell *just* how many people have seen your Tweets with the addition of view counts, shown right next to likes. Now on iOS and Android, web coming soon.<br><br><a href=\"https://help.twitter.com/using-twitter/view-counts\">https://t.co/hrlMQyXJfx</a>`,
    id: '1606055187348688896',
    hashtags: [],
    mentions: [],
    name: 'Support',
    permanentUrl: 'https://twitter.com/Support/status/1606055187348688896',
    photos: [],
    text: 'Replies and likes don’t tell the whole story. We’re making it easier to tell *just* how many people have seen your Tweets with the addition of view counts, shown right next to likes. Now on iOS and Android, web coming soon.\n\nhttps://t.co/hrlMQyXJfx',
    thread: [],
    timeParsed: new Date(Date.UTC(2022, 11, 22, 22, 32, 50, 0)),
    timestamp: 1671748370,
    urls: ['https://help.twitter.com/using-twitter/view-counts'],
    userId: '17874544',
    username: 'Support',
    videos: [],
    isQuoted: false,
    isReply: false,
    isRetweet: false,
    isPin: false,
    sensitiveContent: false,
  };

  const client = await getClient();
  const actual = await client.getTweet('1606055187348688896');
  expect(actual?.views).toBeTruthy();
  delete actual?.likes;
  delete actual?.replies;
  delete actual?.retweets;
  delete actual?.views;
  delete actual?.bookmarkCount;
  expect(actual).toEqual(expected);
});

test('client can get tweet thread', async () => {
  const client = await getClient();
  const tweet = await client.getTweet('1665602315745673217');
  expect(tweet).not.toBeNull();
  expect(tweet?.isSelfThread).toBeTruthy();
  expect(tweet?.thread.length).toStrictEqual(7);
});

test('client can get user tweets', async () => {
  const client = await getClient();

  const userId = '1830340867737178112'; // Replace with a valid user ID
  const maxTweets = 200;

  const response = await client.getUserTweets(userId, maxTweets);

  expect(response.tweets).toBeDefined();
  expect(response.tweets.length).toBeLessThanOrEqual(maxTweets);

  // Check if each object in the tweets array is a valid Tweet object
  response.tweets.forEach((tweet) => {
    expect(tweet.id).toBeDefined();
    expect(tweet.text).toBeDefined();
  });

  expect(response.next).toBeDefined();
}, 30000);

test('sendTweet successfully sends a tweet', async () => {
  const client = await getClient();
  const draftText = `Core updated on ${Date.now().toString()}`;

  const result = await client.sendTweet(draftText);
  console.log('Send tweet result:', result);

  const replyResult = await client.sendTweet('Ignore this', '1430277451452751874');
  console.log('Send reply result:', replyResult);
});

test('client can get a tweet with getTweetV2', async () => {
  const client = await getClient({ authMethod: 'api' });
  if (shouldSkipV2Tests) {
    return console.warn("Skipping 'getTweetV2' test due to missing API keys.");
  }
  const tweetId = '1856441982811529619';

  const tweet: Tweet | null = await client.getTweetV2(tweetId);

  expect(tweet).not.toBeNull();
  expect(tweet?.id).toEqual(tweetId);
  expect(tweet?.text).toBeDefined();
});

test('scraper can delete tweet', async () => {
  const client = await getClient();

  const draftText = 'This Tweet will be deleted' + Date.now().toString();

  const response = await client.sendTweet(draftText);
  const result = await response.json();

  expect(result).toBeDefined();

  const tweetId = result?.data?.create_tweet?.tweet_results?.result?.rest_id;
  expect(tweetId).toBeDefined();

  await client.deleteTweet(tweetId as string);

  // Verify the tweet is actually deleted
  const deletedTweet = await client.getTweet(tweetId as string);
  expect(deletedTweet).toBeNull();
});

test('client can get multiple tweets with getTweetsV2', async () => {
  if (shouldSkipV2Tests) {
    return console.warn("Skipping 'getTweetV2' test due to missing API keys.");
  }
  const client = await getClient({ authMethod: 'api' });
  const tweetIds = ['1856441982811529619', '1856429655215260130'];

  const tweets = await client.getTweetsV2(tweetIds);

  expect(tweets).toBeDefined();
  expect(tweets.length).toBeGreaterThan(0);
  tweets.forEach((tweet) => {
    expect(tweet.id).toBeDefined();
    expect(tweet.text).toBeDefined();
  });
});

test('client can send a tweet with sendTweetV2', async () => {
  if (shouldSkipV2Tests) {
    return console.warn("Skipping 'getTweetV2' test due to missing API keys.");
  }
  const client = await getClient({ authMethod: 'api' });
  const tweetText = `Automated test tweet at ${Date.now()}`;

  const response = await client.sendTweetV2(tweetText);
  expect(response).not.toBeNull();
  expect(response?.id).toBeDefined();
  expect(response?.text).toEqual(tweetText);
});

test('client can create a poll with sendTweetV2', async () => {
  if (shouldSkipV2Tests) {
    return console.warn("Skipping 'getTweetV2' test due to missing API keys.");
  }

  const client = await getClient({ authMethod: 'api' });
  const tweetText = `When do you think we'll achieve AGI (Artificial General Intelligence)? 🤖 Cast your prediction!`;
  const pollData = {
    poll: {
      options: [
        { label: '2025 🗓️' },
        { label: '2026 📅' },
        { label: '2027 🛠️' },
        { label: '2030+ 🚀' },
      ],
      duration_minutes: 1440,
    },
  };
  const response = await client.sendTweetV2(tweetText, undefined, pollData);

  expect(response).not.toBeNull();
  expect(response?.id).toBeDefined();
  expect(response?.text).toEqual(tweetText);

  // Validate poll structure in response
  const poll = response?.poll;
  expect(poll).toBeDefined();
  expect(poll?.options.map((option) => option.label)).toEqual(
    pollData?.poll.options.map((option) => option.label)
  );
});

test('client can send a tweet without media', async () => {
  const client = await getClient();
  const draftText = `Test tweet without media ${Date.now().toString()}`;

  // Send a tweet without any media attachments
  const result = await client.sendTweet(draftText);

  // Log and verify the result
  console.log('Send tweet without media result:', result);
  expect(result.ok).toBeTruthy();
}, 30000);

test('client can send a tweet with image and video', async () => {
  const client = await getClient();
  const draftText = `Test tweet with image and video ${Date.now().toString()}`;

  // Read test image and video files from the test-assets directory
  const imageBuffer = fs.readFileSync(path.join(__dirname, '../test-assets/test-image.jpeg'));
  const videoBuffer = fs.readFileSync(path.join(__dirname, '../test-assets/test-video.mp4'));

  // Prepare media data array with both image and video
  const mediaData = [
    { data: imageBuffer, mediaType: 'image/jpeg' },
    { data: videoBuffer, mediaType: 'video/mp4' },
  ];

  // Send a tweet with both image and video attachments
  const result = await client.sendTweet(draftText, undefined, mediaData);

  // Log and verify the result
  console.log('Send tweet with image and video result:', result);
  expect(result.ok).toBeTruthy();
}, 30000);

test('client can quote tweet without media', async () => {
  const client = await getClient();
  const quotedTweetId = '1776276954435481937';
  const quoteText = `Testing quote tweet without media ${Date.now()}`;

  // Send a quote tweet without any media attachments
  const response = await client.sendQuoteTweet(quoteText, quotedTweetId);

  // Log and verify the response
  console.log('Quote tweet without media result:', response);
  expect(response.ok).toBeTruthy();
}, 30000);

test('client can quote tweet with image and video', async () => {
  const client = await getClient();
  const quotedTweetId = '1776276954435481937';
  const quoteText = `Testing quote tweet with image and video ${Date.now()}`;

  // Read test image and video files from the test-assets directory
  const imageBuffer = fs.readFileSync(path.join(__dirname, '../test-assets/test-image.jpeg'));
  const videoBuffer = fs.readFileSync(path.join(__dirname, '../test-assets/test-video.mp4'));

  // Prepare media data array with both image and video
  const mediaData = [
    { data: imageBuffer, mediaType: 'image/jpeg' },
    { data: videoBuffer, mediaType: 'video/mp4' },
  ];

  // Send a quote tweet with both image and video attachments
  const response = await client.sendQuoteTweet(quoteText, quotedTweetId, {
    mediaData: mediaData,
  });

  // Log and verify the response
  console.log('Quote tweet with image and video result:', response);
  expect(response.ok).toBeTruthy();
}, 30000);

test('client can quote tweet with media', async () => {
  const client = await getClient();
  const quotedTweetId = '1776276954435481937';
  const quoteText = `Testing quote tweet with media ${Date.now()}`;

  // Read test image file
  const imageBuffer = fs.readFileSync(path.join(__dirname, '../test-assets/test-image.jpeg'));

  // Prepare media data with the image
  const mediaData = [{ data: imageBuffer, mediaType: 'image/jpeg' }];

  // Send a quote tweet with the image attachment
  const response = await client.sendQuoteTweet(quoteText, quotedTweetId, {
    mediaData: mediaData,
  });

  // Log and verify the response
  console.log('Quote tweet with media result:', response);
  expect(response.ok).toBeTruthy();
}, 30000);

test('sendTweetWithMedia successfully sends a tweet with media', async () => {
  const client = await getClient();
  const draftText = `Test tweet with media ${Date.now().toString()}`;

  // Read a test image file
  const imageBuffer = fs.readFileSync(path.join(__dirname, '../test-assets/test-image.jpeg'));

  // Prepare media data with the image
  const mediaData = [{ data: imageBuffer, mediaType: 'image/jpeg' }];

  // Send a tweet with the image attachment
  const result = await client.sendTweet(draftText, undefined, mediaData);

  // Log and verify the result
  console.log('Send tweet with media result:', result);
  expect(result.ok).toBeTruthy();
}, 30000);

test('client can like a tweet', async () => {
  const client = await getClient();
  const tweetId = '1776276954435481937'; // Use a real tweet ID for testing

  // Test should not throw an error
  await expect(client.likeTweet(tweetId)).resolves.not.toThrow();
});

test('client can retweet', async () => {
  const client = await getClient();
  const tweetId = '1776276954435481937';

  // Test should not throw an error
  await expect(client.retweet(tweetId)).resolves.not.toThrow();
});

test('client can follow user', async () => {
  const client = await getClient();
  const username = 'elonmusk'; // Use a real username for testing

  // Test should not throw an error
  await expect(client.followUser(username)).resolves.not.toThrow();
}, 30000);

test('client cannot get article using getTweet', async () => {
  const client = await getClient();
  // X introducing article: http://x.com/i/article/1765821414056120320
  const tweet = await client.getTweet('1765884209527394325');

  expect(tweet).not.toBeNull();
  expect(tweet?.text).toMatch(/https?:\/\/t.co\//);
  expect(tweet?.urls[0]).toMatch(/https?:\/\/x.com\/i\/article\//);
}, 30000);

test('client can get article using getArticle', async () => {
  const client = await getClient();
  // X introducing article: http://x.com/i/article/1765821414056120320
  const article = await client.getArticle('1765884209527394325');

  expect(article).not.toBeNull();
  expect(article?.title).toMatch(/Introducing Articles on X/);
}, 30000);
