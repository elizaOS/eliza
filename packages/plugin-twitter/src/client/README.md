# agent-twitter-client

## Setup

Configure environment variables for authentication.

```
TWITTER_USERNAME=    # Account username
TWITTER_PASSWORD=    # Account password
TWITTER_EMAIL=       # Account email
PROXY_URL=           # HTTP(s) proxy for requests (necessary for browsers)

# Twitter API v2 credentials for tweet and poll functionality
TWITTER_API_KEY=               # Twitter API Key
TWITTER_API_SECRET_KEY=        # Twitter API Secret Key
TWITTER_ACCESS_TOKEN=          # Access Token for Twitter API v2
TWITTER_ACCESS_TOKEN_SECRET=   # Access Token Secret for Twitter API v2
```

### Getting Twitter Cookies

It is important to use Twitter cookies to avoid sending a new login request to Twitter every time you want to perform an action.

In your application, you will likely want to check for existing cookies. If cookies are not available, log in with user authentication credentials and cache the cookies for future use.

```ts
const client = await getClient({ authMethod: 'password' });

client.getCookies().then((cookies) => {
  console.log(cookies);
  // Remove 'Cookies' and save the cookies as a JSON array
});
```

## Getting Started

```ts
const client = new Client();
await client.login('username', 'password');

// If using v2 functionality (currently required to support polls)
await client.login(
  'username',
  'password',
  'email',
  'appKey',
  'appSecret',
  'accessToken',
  'accessSecret'
);

const tweets = await client.getTweets('elonmusk', 10);
const tweetsAndReplies = client.getTweetsAndReplies('elonmusk');
const latestTweet = await client.getLatestTweet('elonmusk');
const tweet = await client.getTweet('1234567890123456789');
await client.sendTweet('Hello world!');

// Create a poll
await client.sendTweetV2(`What's got you most hyped? Let us know! 🤖💸`, undefined, {
  poll: {
    options: [
      { label: 'AI Innovations 🤖' },
      { label: 'Crypto Craze 💸' },
      { label: 'Both! 🌌' },
      { label: 'Neither for Me 😅' },
    ],
    durationMinutes: 120, // Duration of the poll in minutes
  },
});
```

### Fetching Specific Tweet Data (V2)

```ts
// Fetch a single tweet with poll details
const tweet = await client.getTweetV2('1856441982811529619', {
  expansions: ['attachments.poll_ids'],
  pollFields: ['options', 'end_datetime'],
});
console.log('tweet', tweet);

// Fetch multiple tweets with poll and media details
const tweets = await client.getTweetsV2(['1856441982811529619', '1856429655215260130'], {
  expansions: ['attachments.poll_ids', 'attachments.media_keys'],
  pollFields: ['options', 'end_datetime'],
  mediaFields: ['url', 'preview_image_url'],
});
console.log('tweets', tweets);
```

## API

### Authentication

```ts
// Log in
await client.login('username', 'password');

// Log out
await client.logout();

// Check if logged in
const isLoggedIn = await client.isLoggedIn();

// Get current session cookies
const cookies = await client.getCookies();

// Set current session cookies
await client.setCookies(cookies);

// Clear current cookies
await client.clearCookies();
```

### Profile

```ts
// Get a user's profile
const profile = await client.getProfile('TwitterDev');

// Get a user ID from their screen name
const userId = await client.getUserIdByScreenName('TwitterDev');

// Get logged-in user's profile
const me = await client.me();
```

### Search

```ts
import { SearchMode } from 'agent-twitter-client';

// Search for recent tweets
const tweets = client.searchTweets('#nodejs', 20, SearchMode.Latest);

// Search for profiles
const profiles = client.searchProfiles('John', 10);

// Fetch a page of tweet results
const results = await client.fetchSearchTweets('#nodejs', 20, SearchMode.Top);

// Fetch a page of profile results
const profileResults = await client.fetchSearchProfiles('John', 10);
```

### Relationships

```ts
// Get a user's followers
const followers = client.getFollowers('12345', 100);

// Get who a user is following
const following = client.getFollowing('12345', 100);

// Fetch a page of a user's followers
const followerResults = await client.fetchProfileFollowers('12345', 100);

// Fetch a page of who a user is following
const followingResults = await client.fetchProfileFollowing('12345', 100);

// Follow a user
const followUserResults = await client.followUser('elonmusk');
```

### Trends

```ts
// Get current trends
const trends = await client.getTrends();

// Fetch tweets from a list
const listTweets = await client.fetchListTweets('1234567890', 50);
```

### Tweets

```ts
// Get a user's tweets
const tweets = client.getTweets('TwitterDev');

// Fetch the home timeline
const homeTimeline = await client.fetchHomeTimeline(10, ['seenTweetId1', 'seenTweetId2']);

// Get a user's liked tweets
const likedTweets = client.getLikedTweets('TwitterDev');

// Get a user's tweets and replies
const tweetsAndReplies = client.getTweetsAndReplies('TwitterDev');

// Get tweets matching specific criteria
const timeline = client.getTweets('TwitterDev', 100);
const retweets = await client.getTweetsWhere(timeline, (tweet) => tweet.isRetweet);

// Get a user's latest tweet
const latestTweet = await client.getLatestTweet('TwitterDev');

// Get a specific tweet by ID
const tweet = await client.getTweet('1234567890123456789');

// Send a tweet
const sendTweetResults = await client.sendTweet('Hello world!');

// Send a quote tweet - Media files are optional
const sendQuoteTweetResults = await client.sendQuoteTweet('Hello world!', '1234567890123456789', [
  'mediaFile1',
  'mediaFile2',
]);

// Retweet a tweet
const retweetResults = await client.retweet('1234567890123456789');

// Like a tweet
const likeTweetResults = await client.likeTweet('1234567890123456789');
```

## Sending Tweets with Media

### Media Handling

The client requires media files to be processed into a specific format before sending:

- Media must be converted to Buffer format
- Each media file needs its MIME type specified
- This helps the client distinguish between image and video processing models

### Basic Tweet with Media

```ts
// Example: Sending a tweet with media attachments
const mediaData = [
  {
    data: fs.readFileSync('path/to/image.jpg'),
    mediaType: 'image/jpeg',
  },
  {
    data: fs.readFileSync('path/to/video.mp4'),
    mediaType: 'video/mp4',
  },
];

await client.sendTweet('Hello world!', undefined, mediaData);
```

### Supported Media Types

```ts
// Image formats and their MIME types
const imageTypes = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

// Video format
const videoTypes = {
  '.mp4': 'video/mp4',
};
```

### Media Upload Limitations

- Maximum 4 images per tweet
- Only 1 video per tweet
- Maximum video file size: 512MB
- Supported image formats: JPG, PNG, GIF
- Supported video format: MP4

## Grok Integration

This client provides programmatic access to Grok through Twitter's interface, offering a unique capability that even Grok's official API cannot match - access to real-time Twitter data. While Grok has a standalone API, only by interacting with Grok through Twitter can you leverage its ability to analyze and respond to live Twitter content. This makes it the only way to programmatically access an LLM with direct insight into Twitter's real-time information. [@grokkyAi](https://x.com/grokkyAi)

### Basic Usage

```ts
const client = new Client();
await client.login('username', 'password');

// Start a new conversation
const response = await client.grokChat({
  messages: [{ role: 'user', content: 'What are your thoughts on AI?' }],
});

console.log(response.message); // Grok's response
console.log(response.messages); // Full conversation history
```

If no `conversationId` is provided, the client will automatically create a new conversation.

### Handling Rate Limits

Grok has rate limits of 25 messages every 2 hours for non-premium accounts. The client provides rate limit information in the response:

```ts
const response = await client.grokChat({
  messages: [{ role: 'user', content: 'Hello!' }],
});

if (response.rateLimit?.isRateLimited) {
  console.log(response.rateLimit.message);
  console.log(response.rateLimit.upsellInfo); // Premium upgrade information
}
```

### Response Types

The Grok integration includes TypeScript types for better development experience:

```ts
interface GrokChatOptions {
  messages: GrokMessage[];
  conversationId?: string;
  returnSearchResults?: boolean;
  returnCitations?: boolean;
}

interface GrokChatResponse {
  conversationId: string;
  message: string;
  messages: GrokMessage[];
  webResults?: any[];
  metadata?: any;
  rateLimit?: GrokRateLimit;
}
```

### Advanced Usage

```ts
const response = await client.grokChat({
  messages: [{ role: 'user', content: 'Research quantum computing' }],
  returnSearchResults: true, // Include web search results
  returnCitations: true, // Include citations for information
});

// Access web results if available
if (response.webResults) {
  console.log('Sources:', response.webResults);
}

// Full conversation with history
console.log('Conversation:', response.messages);
```

### Limitations

- Message history prefilling is currently limited due to unofficial API usage
- Rate limits are enforced (25 messages/2 hours for non-premium)
