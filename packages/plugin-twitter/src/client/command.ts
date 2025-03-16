import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import dotenv from 'dotenv';
// Your existing imports
import { Client } from './client';
import type { Photo, Tweet } from './tweets';

// Load environment variables from .env file
dotenv.config();

// Create a new Client instance
const client = new Client();

// Create readline interface for CLI
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> ',
});

// Function to log in and save cookies
/**
 * Asynchronously logs in to Twitter using credentials from environment variables,
 * retrieves the current session cookies, and saves the cookies to a JSON file
 * for future sessions.
 *
 * @returns {Promise<void>} A Promise that resolves once the login is complete and cookies are saved
 */
async function loginAndSaveCookies() {
  try {
    // Log in using credentials from environment variables
    await client.login(
      process.env.TWITTER_USERNAME!,
      process.env.TWITTER_PASSWORD!,
      process.env.TWITTER_EMAIL
    );

    // Retrieve the current session cookies
    const cookies = await client.getCookies();

    // Save the cookies to a JSON file for future sessions
    fs.writeFileSync(path.resolve(__dirname, 'cookies.json'), JSON.stringify(cookies));

    console.log('Logged in and cookies saved.');
  } catch (error) {
    console.error('Error during login:', error);
  }
}

// Function to load cookies from the JSON file
/**
 * Asynchronously loads cookies from a JSON file in the file system and sets them for the current session.
 * @returns {Promise<void>} A promise that resolves once the cookies are successfully loaded and set, or rejects if an error occurs.
 */
async function loadCookies() {
  try {
    // Read cookies from the file system
    const cookiesData = fs.readFileSync(path.resolve(__dirname, 'cookies.json'), 'utf8');
    const cookiesArray = JSON.parse(cookiesData);

    // Map cookies to the correct format (strings)
    const cookieStrings = cookiesArray.map((cookie: any) => {
      return `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${
        cookie.secure ? 'Secure' : ''
      }; ${cookie.httpOnly ? 'HttpOnly' : ''}; SameSite=${cookie.sameSite || 'Lax'}`;
    });

    // Set the cookies for the current session
    await client.setCookies(cookieStrings);

    console.log('Cookies loaded from file.');
  } catch (error) {
    console.error('Error loading cookies:', error);
  }
}

// Function to ensure the client is authenticated
/**
 * Asynchronous function to ensure the user is authenticated.
 * Checks if cookies.json exists to decide whether to log in or load cookies.
 * If cookies exist, it loads the cookies and informs the user that they are already logged in.
 * If no cookie file is found, it logs in and saves the cookies.
 */
async function ensureAuthenticated() {
  // Check if cookies.json exists to decide whether to log in or load cookies
  if (fs.existsSync(path.resolve(__dirname, 'cookies.json'))) {
    // Load cookies if the file exists
    await loadCookies();

    // Inform the user that they are already logged in
    console.log('You are already logged in. No need to log in again.');
  } else {
    // Log in and save cookies if no cookie file is found
    await loginAndSaveCookies();
  }
}

// Function to send a tweet with optional media files
/**
 * Asynchronously sends a tweet command with optional media files and reply to tweet ID.
 * @param {string} text - The text content of the tweet.
 * @param {string[]} mediaFiles - Optional array of paths to media files to attach to the tweet.
 * @param {string} replyToTweetId - Optional ID of the tweet to reply to.
 * @returns {Promise<string | null>} A promise that resolves with the ID of the sent tweet,
 * or null if there was an error.
 */
async function sendTweetCommand(
  text: string,
  mediaFiles?: string[],
  replyToTweetId?: string
): Promise<string | null> {
  try {
    let mediaData;

    if (mediaFiles && mediaFiles.length > 0) {
      // Prepare media data by reading files and determining media types
      mediaData = await Promise.all(
        mediaFiles.map(async (filePath) => {
          const absolutePath = path.resolve(__dirname, filePath);
          const buffer = await fs.promises.readFile(absolutePath);
          const ext = path.extname(filePath).toLowerCase();
          const mediaType = getMediaType(ext);
          return { data: buffer, mediaType };
        })
      );
    }

    // Send the tweet using the updated sendTweet function
    const response = await client.sendTweet(text, replyToTweetId, mediaData);

    // Parse the response to extract the tweet ID
    const responseData = await response.json();
    const tweetId = responseData?.data?.create_tweet?.tweet_results?.result?.rest_id;

    if (tweetId) {
      console.log(`Tweet sent: "${text}" (ID: ${tweetId})`);
      return tweetId;
    }
    console.error('Tweet ID not found in response.');
    return null;
  } catch (error) {
    console.error('Error sending tweet:', error);
    return null;
  }
}

// Function to get media type based on file extension
/**
 * Returns the corresponding media type based on the file extension provided.
 * @param {string} ext - The file extension to determine the media type for.
 * @returns {string} - The corresponding media type for the given file extension.
 */
function getMediaType(ext: string): string {
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.mp4':
      return 'video/mp4';
    // Add other media types as needed
    default:
      return 'application/octet-stream';
  }
}

// Function to get replies to a specific tweet
/**
 * Asynchronously retrieves the replies to a given tweet ID.
 *
 * @param {string} tweetId - The ID of the tweet to fetch replies for.
 * @returns {Promise<Tweet[]>} An array of tweets that are direct replies to the original tweet.
 */
async function getRepliesToTweet(tweetId: string): Promise<Tweet[]> {
  const replies: Tweet[] = [];
  try {
    // Construct the search query to find replies
    const query = `to:${process.env.TWITTER_USERNAME} conversation_id:${tweetId}`;
    const maxReplies = 100; // Maximum number of replies to fetch
    const searchMode = 1; // SearchMode.Latest

    // Fetch replies matching the query
    for await (const tweet of client.searchTweets(query, maxReplies, searchMode)) {
      // Check if the tweet is a direct reply to the original tweet
      if (tweet.inReplyToStatusId === tweetId) {
        replies.push(tweet);
      }
    }

    console.log(`Found ${replies.length} replies to tweet ID ${tweetId}.`);
  } catch (error) {
    console.error('Error fetching replies:', error);
  }
  return replies;
}

// Function to reply to a specific tweet
/**
 * Asynchronously sends a reply tweet to a tweet with the specified tweet ID.
 *
 * @param {string} tweetId - The ID of the tweet to reply to.
 * @param {string} text - The text content of the reply tweet.
 * @returns {Promise<void>} A Promise that resolves once the reply tweet is sent.
 */
async function replyToTweet(tweetId: string, text: string) {
  try {
    // Pass empty array for mediaFiles (2nd param) and tweetId as replyToTweetId (3rd param)
    const replyId = await sendTweetCommand(text, [], tweetId);

    if (replyId) {
      console.log(`Reply sent (ID: ${replyId}).`);
    }
  } catch (error) {
    console.error('Error sending reply:', error);
  }
}

// Function to get photos from a specific tweet
/**
 * Asynchronously fetches photos associated with a tweet based on the tweet ID.
 *
 * @param {string} tweetId - The ID of the tweet to retrieve photos from.
 * @returns {Promise<void>} - A Promise that resolves once the photos are retrieved and displayed.
 */
async function getPhotosFromTweet(tweetId: string) {
  try {
    // Fetch the tweet by its ID
    const tweet = await client.getTweet(tweetId);

    // Check if the tweet exists and contains photos
    if (tweet && tweet.photos.length > 0) {
      console.log(`Found ${tweet.photos.length} photo(s) in tweet ID ${tweetId}:`);
      // Iterate over each photo and display its URL
      tweet.photos.forEach((photo: Photo, index: number) => {
        console.log(`Photo ${index + 1}: ${photo.url}`);
      });
    } else {
      console.log('No photos found in the specified tweet.');
    }
  } catch (error) {
    console.error('Error fetching tweet:', error);
  }
}

// Function to parse command line while preserving quoted strings
/**
 * Parses a command line string into an array of individual arguments.
 *
 * @param {string} commandLine - The command line string to parse
 * @returns {string[]} An array of individual arguments parsed from the command line
 */
function parseCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let currentArg = '';
  let inQuotes = false;

  for (let i = 0; i < commandLine.length; i++) {
    const char = commandLine[i];

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ' ' && !inQuotes) {
      if (currentArg) {
        args.push(currentArg);
        currentArg = '';
      }
    } else {
      currentArg += char;
    }
  }

  if (currentArg) {
    args.push(currentArg);
  }

  return args;
}

// Function to execute commands
/**
 * Asynchronously executes a Twitter command based on the provided command line input.
 * @param {string} commandLine - The command line input string containing the command and arguments.
 * @returns {Promise<void>} - A Promise that resolves once the command has been executed.
 */
async function executeCommand(commandLine: string) {
  const args = parseCommandLine(commandLine);
  const command = args.shift(); // Remove and get the first element as command

  if (!command) return;

  switch (command) {
    case 'login':
      await loginAndSaveCookies();
      break;

    case 'send-tweet': {
      await ensureAuthenticated();

      // First argument is the tweet text
      const tweetText = args[0];
      // Remaining arguments are media file paths
      const mediaFiles = args.slice(1);

      if (!tweetText) {
        console.log('Please provide text for the tweet.');
      } else {
        // Call the sendTweetCommand with optional media files
        await sendTweetCommand(tweetText, mediaFiles);
      }
      break;
    }

    case 'send-long-tweet': {
      await ensureAuthenticated();

      // First argument is the tweet text
      const tweetText = args[0];
      // Remaining arguments are media file paths
      const mediaFiles = args.slice(1);

      if (!tweetText) {
        console.log('Please provide text for the long tweet.');
      } else {
        // Call the sendLongTweetCommand with optional media files
        await sendLongTweetCommand(tweetText, mediaFiles);
      }
      break;
    }

    case 'get-tweets': {
      await ensureAuthenticated();
      const username = args[0];
      if (!username) {
        console.log('Please provide a username.');
      } else {
        try {
          const maxTweets = 20; // Maximum number of tweets to fetch
          const tweets: Tweet[] = [];
          for await (const tweet of client.getTweets(username, maxTweets)) {
            tweets.push(tweet);
          }
          console.log(`Fetched ${tweets.length} tweets from @${username}:`);
          tweets.forEach((tweet) => {
            console.log(`- [${tweet.id}] ${tweet.text}`);
          });
        } catch (error) {
          console.error('Error fetching tweets:', error);
        }
      }
      break;
    }

    case 'get-replies': {
      await ensureAuthenticated();
      const tweetId = args[0];
      if (!tweetId) {
        console.log('Please provide a tweet ID.');
      } else {
        const replies = await getRepliesToTweet(tweetId);
        console.log(`Found ${replies.length} replies:`);
        replies.forEach((reply) => {
          console.log(`- @${reply.username}: ${reply.text}`);
        });
      }
      break;
    }

    case 'reply-to-tweet': {
      await ensureAuthenticated();
      const replyTweetId = args[0];
      const replyText = args.slice(1).join(' ');
      if (!replyTweetId || !replyText) {
        console.log('Please provide a tweet ID and text to reply.');
      } else {
        await replyToTweet(replyTweetId, replyText);
      }
      break;
    }

    case 'get-mentions':
      await ensureAuthenticated();
      try {
        const maxTweets = 20; // Maximum number of mentions to fetch
        const mentions: Tweet[] = [];
        const query = `@${process.env.TWITTER_USERNAME}`;
        const searchMode = 1; // SearchMode.Latest

        // Fetch recent mentions
        for await (const tweet of client.searchTweets(query, maxTweets, searchMode)) {
          // Exclude your own tweets
          if (tweet.username !== process.env.TWITTER_USERNAME) {
            mentions.push(tweet);
          }
        }
        console.log(`Found ${mentions.length} mentions:`);
        mentions.forEach((tweet) => {
          console.log(`- [${tweet.id}] @${tweet.username}: ${tweet.text}`);
        });

        // Fetch replies to each mention
        for (const mention of mentions) {
          // Get replies to the mention
          const replies = await getRepliesToTweet(mention.id!);
          console.log(`Replies to mention [${mention.id}] by @${mention.username}:`);
          replies.forEach((reply) => {
            console.log(`- [${reply.id}] @${reply.username}: ${reply.text}`);
          });
        }
      } catch (error) {
        console.error('Error fetching mentions:', error);
      }
      break;

    case 'help':
      console.log('Available commands:');
      console.log('  login                     - Login to Twitter and save cookies');
      console.log(
        '  send-tweet <text> [mediaFiles...]       - Send a tweet with optional media attachments'
      );
      console.log(
        '  send-long-tweet <text> [mediaFiles...]  - Send a long tweet (Note Tweet) with optional media attachments'
      );
      console.log('  get-tweets <username>     - Get recent tweets from the specified user');
      console.log('  get-replies <tweetId>     - Get replies to the specified tweet ID');
      console.log('  reply-to-tweet <tweetId> <text> - Reply to a tweet with the specified text');
      console.log('  get-mentions              - Get recent mentions of your account');
      console.log('  exit                      - Exit the application');
      console.log('  help                      - Show this help message');
      console.log(
        '  send-quote-tweet <tweetId> "<text>" [mediaFiles...] - Send a quote tweet with optional media attachments'
      );
      console.log('  get-photos <tweetId>      - Get photos from a specific tweet');
      console.log('  like <tweetId>            - Like a tweet by its ID');
      console.log('  retweet <tweetId>         - Retweet a tweet by its ID');
      console.log('  follow <username>         - Follow a user by their username');
      break;

    case 'exit':
      console.log('Exiting...');
      rl.close();
      process.exit(0);
      break;

    case 'get-photos': {
      await ensureAuthenticated();
      const tweetId = args[0];
      if (!tweetId) {
        console.log('Please provide a tweet ID.');
      } else {
        await getPhotosFromTweet(tweetId);
      }
      break;
    }

    case 'send-quote-tweet': {
      await ensureAuthenticated();

      if (args.length < 2) {
        console.log('Usage: send-quote-tweet <tweetId> "<text>" [mediaFile1] [mediaFile2] ...');
        break;
      }

      const quotedTweetId = args[0];
      const text = args[1];
      const mediaFiles = args.slice(2);

      // Prepare the quote tweet text including the quoted tweet URL
      const quoteTweetText = `${text} https://twitter.com/user/status/${quotedTweetId}`;

      // Send the quote tweet using the sendTweetCommand function
      await sendTweetCommand(quoteTweetText, mediaFiles);
      break;
    }

    case 'like': {
      await ensureAuthenticated();
      const tweetId = args[0];
      if (!tweetId) {
        console.log('Please provide a tweet ID.');
      } else {
        try {
          // Attempt to like the tweet
          await client.likeTweet(tweetId);
          console.log(`Tweet ID ${tweetId} liked successfully.`);
        } catch (error) {
          console.error('Error liking tweet:', error);
        }
      }
      break;
    }

    case 'retweet': {
      await ensureAuthenticated();
      const retweetId = args[0];
      if (!retweetId) {
        console.log('Please provide a tweet ID.');
      } else {
        try {
          // Attempt to retweet the tweet
          await client.retweet(retweetId);
          console.log(`Tweet ID ${retweetId} retweeted successfully.`);
        } catch (error) {
          console.error('Error retweeting tweet:', error);
        }
      }
      break;
    }

    case 'follow': {
      await ensureAuthenticated();
      const usernameToFollow = args[0];
      if (!usernameToFollow) {
        console.log('Please provide a username to follow.');
      } else {
        try {
          // Attempt to follow the user
          await client.followUser(usernameToFollow);
          console.log(`Successfully followed user @${usernameToFollow}.`);
        } catch (error) {
          console.error('Error following user:', error);
        }
      }
      break;
    }

    default:
      console.log(`Unknown command: ${command}. Type 'help' to see available commands.`);
      break;
  }
}

// Function to send a long tweet (Note Tweet) with optional media files
/**
 * Asynchronously sends a long tweet command with optional media files and replyToTweetId.
 * @param {string} text - The text content of the tweet.
 * @param {string[]} [mediaFiles] - Array of file paths for media files to include in the tweet.
 * @param {string} [replyToTweetId] - The ID of the tweet to reply to.
 * @returns {Promise<string|null>} A Promise that resolves with the tweet ID if successful, or null if an error occurs.
 */
async function sendLongTweetCommand(
  text: string,
  mediaFiles?: string[],
  replyToTweetId?: string
): Promise<string | null> {
  try {
    let mediaData;

    if (mediaFiles && mediaFiles.length > 0) {
      // Prepare media data by reading files and determining media types
      mediaData = await Promise.all(
        mediaFiles.map(async (filePath) => {
          const absolutePath = path.resolve(__dirname, filePath);
          const buffer = await fs.promises.readFile(absolutePath);
          const ext = path.extname(filePath).toLowerCase();
          const mediaType = getMediaType(ext);
          return { data: buffer, mediaType };
        })
      );
    }

    // Send the long tweet using the sendLongTweet function
    const response = await client.sendLongTweet(text, replyToTweetId, mediaData);

    // Parse the response to extract the tweet ID
    const responseData = await response.json();
    const tweetId = responseData?.data?.notetweet_create?.tweet_results?.result?.rest_id;

    if (tweetId) {
      console.log(`Long tweet sent: "${text.substring(0, 50)}..." (ID: ${tweetId})`);
      return tweetId;
    }
    console.error('Tweet ID not found in response.');
    return null;
  } catch (error) {
    console.error('Error sending long tweet:', error);
    return null;
  }
}

// Main function to start the CLI
(async () => {
  console.log('Welcome to the Twitter CLI Interface!');
  console.log("Type 'help' to see available commands.");
  rl.prompt();

  rl.on('line', async (line) => {
    await executeCommand(line);
    rl.prompt();
  }).on('close', () => {
    console.log('Goodbye!');
    process.exit(0);
  });
})();
