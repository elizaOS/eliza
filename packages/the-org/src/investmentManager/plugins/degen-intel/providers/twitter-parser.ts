// TODO: Replace anthropic with runtime.useModel
// replace moment with helper functions

import {
	type Content,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type UUID,
	createUniqueUuid,
	logger,
} from "@elizaos/core";
import type { Sentiment, TwitterContent } from "../types";

const makeBulletpointList = (array: string[]) => {
	return array.map((a) => ` - ${a}`).join("\n");
};

/**
 * Array of examples containing information about various tokens and developments in the crypto industry.
 * Each example includes details such as token names, market trends, volume, market cap, and upcoming launches.
 */
const examples = [
	"$KUDAI 87% retention rate after 30 days. smart engagement up 1333% week over week. arbitrum expansion next with full gmx integration",
	"ecosystem play emerging\n\nboth tokens showing unusual strength - $HWTR running 12m mcap in first 24h, $MON bringing established gaming liquidity to HL",
	"alliance dao backing + $54m daily volume on $GRIFT. defai sector at $2.5b. agent infrastructure capturing value faster than agents themselves",
	"morpho lending markets at 100% utilization. lenders trapped, borrowers facing liquidation. protocol revenue switch activated while crisis unfolds",
	"$AERO voters collected $7.8M in fees last week alone. alm v2 launching. base's flagship dex running 1,109% apr on select pairs",
	"$ZEUS sitting at 21.8 zbtc minted with mechanismcap and animoca verifying cross-chain. current mcap 249m",
	"13 states expected to pass sbr legislation by summer\n\nonly 21m $btc exist\n\nstates about to learn about supply shock",
	"trump cards doing 2.38M $POL volume in last 24h. floor at 1.3k from 99 mint. classic season signal when pfp floors detach from reality",
	"$ethos launching on base mainnet next week after 15 months of dev. smart contracts audited\n\nprivate testnet wrapping up",
	"original $ROSS donated $250k to ross ulbricht's wallet, $300k to family. 8 month track record vs fresh fork trying to steal narrative",
	"hardware accelerated L2s are no longer theoretical\n\n$LAYER processing 1M TPS through InfiniSVM, pushing 100Gbps+ bandwidth at mainnet. already managing 350M tvl",
	"gaming and AI infrastructure are converging\n\n$PRIME at $14.29 with $749M mcap building a multi-vertical platform combining TCG, AI agents, and competitive gaming",
	"$LLM represents perfect fusion of memes and AI narratives on solana. from ascii art generator to binance alpha featured project with institutional backing",
	"$AERO doing more volume than uniswap's top pools across mainnet + base + arb\n\nreality check: major assets now trade more on aerodrome than anywhere else on-chain",
	"makersplace shutting down after pioneering $69M beeple sale\n\nplatform economics dead but the builders are evolving",
	"721 total supply. open edition with 6.9 week delayed reveal. multiple whitelists being distributed through bera ecosystem fcfs",
	"$qude implementing basic completions while others push assistants and tools\n\nsdk launch upcoming with enhanced token holder rewards\n\nonly non-scam ai in dex top 30",
	"pudgy penguins expanding beyond nfts\n\nmobile game on abstract chain, trading cards through ocap games, integration with agents of poker",
	"defai narrative hitting peak momentum. $SAI touched new ath of $0.106 today with 8.4% 24h gain. trading at $0.104 with 45% weekly growth",
	"same backers as $TAO but 300x smaller market cap\n\n$SAI generating $4.8M daily volume across gate, mexc, binance\n\ntier 1 listing imminent",
	"$BONK holding strength while market bleeds from $TRUMP launch\n\n10.7% up in 24h while others red. resistance becomes support",
	"now that $AERO is eating uniswap's volume on base + arb + mainnet, will velodrome and sushi exit?",
	"circle minted $250m $usdc on solana 5 hours ago. total solana mints now $2.2b in past 18 days",
	"everything leads to jan 20 release date. volume hitting $13.8m with price swinging between $0.013 and $0.023 in 24h",
	"$J launching on okx jan 22. dual token structure with $JAMBO creates real incentives for network growth\n\n20 token airdrop live",
	"40+ AVS services building on eigenlayer infrastructure, primarily focused on AI verification and security sharing protocols",
	"$build enabling direct web2 AI agent integration while trading at 41m mcap vs comparable infra at 3.6b. market needs to explain this gap",
	"survival belongs to brand builders not fee collectors\n\npudgy trading 26 eth floor while launching physical cards, plushies and blockchain games",
	"camelot dex already live on educhain. first L3 specialized for education apps and on-chain education finance. $EDU ecosystem expanding",
	"dual token system incoming w/ $anon + $anon33\n\ndefai category added to gecko tracking. 150% gain last 14 days on rising volumes",
	"the retardio network went deeper than expected\n\n$KUDAI automated GMX/uni v3 positions generated 350k in first week revenue with only 6000 holders",
	"$TRUMP just flipped $PEPE. what happens next to the overall memecoin market cap",
	"launch timing looks right. $42.4M mcap, burning tokens from listings + uni v3 fees\n\nformer aethir cco mack lorden just joined as chief commercial",
	"$GRPH studio launches with token burn mechanism\n\nfree development stays open while managed infrastructure requires token stake. 3000 personalities generated",
	"merit systems raises $10m from a16z + blockchain capital to build open source attribution protocol. ex-jolt zk builder and bcap engineers behind it",
	"$TRUMP flips $PEPE in market cap. 8.6B vs 8.5B\n\nFirst time since PEPE launch a new memecoin has achieved this",
	"best part about $SWORLD: vanguard pfp rebirth incoming\n\nclean token distribution through staking\n\nopen alpha running with 2 months left until close",
	"pudgy penguins showing the way. $PENGU at $2B mcap with 615k holders. pushing into abstract chain gaming while traditional marketplaces collapse",
	"current state: $ONDO mc 1.99B, 24h vol 748M, perp OI 440M. recent whale dumped 10.9M tokens for 13.5M usdc",
	"solana lst market hitting critical mass. 9% of total stake now in liquid staking tokens unlocking $7.5B productive sol\n\nbnSOL printed largest weekly inflow in chain history at $248M",
	"ETH/USD trading up to 1000x leverage\n\nsUSDe interest rate plays up to 10000x\n\npartnerships with ethena and lido for yield generation",
	"lending volumes growing fast. protocol revenue data incoming\n\nbase tvl already crossing early targets",
	"700k users across 128 countries already using web3 phones\n\njambo building real infrastructure while others just talk about adoption",
];

const rolePrompt = "You are a tweet analyzer.";

/**
 * Generate a summary and sentiment analysis of tweets related to the cryptocurrency market.
 *
 * @param {string[]} tweets - An array of tweets to analyze.
 * @param {string[]} examples - An array of example texts to reference in the summary.
 * @returns {Object} - A JSON object with a summary of the tweets and sentiment analysis of occurring tokens.
 */
const template = `Write a summary of what is happening in the tweets. The main topic is the cryptocurrency market, but you don't have to state that explicitly.
You will also be analyzing the tokens that occur in the tweet and tell us whether their sentiment is positive or negative.

## Analyze the followings tweets:
{{tweets}}

## Rules:

## Example texts:
${makeBulletpointList(examples)}

Strictly return the following json:

{
   "text":"the summary of what has happened in those tweets, with a max length of 200 characters. Refer to ## Example texts",
   "occuringTokens":[
      {
         "token":"the token symbol, like: ETH, SOL, BTC etc.",
         "sentiment":"positive is between 1 and 100 and negative is from -1 to -100",
         "reason":"a short sentence explaining the reason for this sentiment score"
      }
   ]
}
`;

export default class TwitterParser {
	runtime: IAgentRuntime;
	roomId: UUID;

	constructor(runtime: IAgentRuntime) {
		this.runtime = runtime;
		// Create a consistent room ID for all sentiment analysis
		this.roomId = createUniqueUuid(runtime, "twitter-sentiment-analysis");
	}

	async fillTimeframe() {
		/** Each timeframe is always 1 hour. */
		const cachedSentiments = await this.runtime
			
			.getCache<Sentiment[]>("sentiments");
		const sentiments: Sentiment[] = cachedSentiments ? cachedSentiments : [];

		const lookUpDate =
			sentiments.length > 0
				? sentiments.sort(
						(a, b) =>
							new Date(b.timeslot).getTime() - new Date(a.timeslot).getTime(),
					)[0].timeslot
				: null;

		const start = new Date(lookUpDate || "2025-01-01T00:00:00.000Z");
		start.setUTCHours(0, 0, 0, 0);

		const today = new Date();
		today.setUTCHours(23, 59, 59, 999);

		const diff = Math.floor(
			(today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
		);
		const timeSlots: Sentiment[] = [];

		for (let day = 0; day <= diff; day++) {
			const now = new Date(start);
			now.setUTCDate(start.getUTCDate() + day);

			for (let hour = 0; hour <= 23; hour++) {
				const timeslotDate = new Date(now);
				timeslotDate.setUTCHours(hour, 0, 0, 0);
				const timeslot = timeslotDate.toISOString();

				const rightNow = new Date();

				/** If it is a timeslot in the future, there is no point in filling it in */
				if (timeslotDate > rightNow) {
					break;
				}

				// Check if this timeslot already exists
				const exists = sentiments.some(
					(s) => new Date(s.timeslot).getTime() === timeslotDate.getTime(),
				);
				if (!exists) {
					timeSlots.push({
						timeslot,
						processed: false,
					});
				}
			}
		}

		if (timeSlots.length > 0) {
			const updatedSentiments = [...sentiments, ...timeSlots];
			await this.runtime
				
				.setCache<Sentiment[]>("sentiments", updatedSentiments);
		}

		logger.debug(`Updated timeframes, added ${timeSlots.length} new slots`);
	}

	async parseTweets() {
		await this.fillTimeframe();

		// Get sentiments
		const cachedSentiments = await this.runtime
			
			.getCache<Sentiment[]>("sentiments");
		const sentiments: Sentiment[] = cachedSentiments ? cachedSentiments : [];

		const now = new Date();
		const oneHourAgo = new Date(now);
		oneHourAgo.setUTCHours(now.getUTCHours() - 1);

		const twoDaysAgo = new Date(now);
		twoDaysAgo.setUTCDate(now.getUTCDate() - 2);

		const unprocessedSentiment = sentiments.find(
			(s) =>
				!s.processed &&
				new Date(s.timeslot) <= oneHourAgo &&
				new Date(s.timeslot) >= twoDaysAgo,
		);

		if (!unprocessedSentiment) {
			logger.debug("No unprocessed timeslots available.");
			return true;
		}

		logger.debug(
			`Trying to process ${new Date(unprocessedSentiment.timeslot).toISOString()}`,
		);

		const timeslot = new Date(unprocessedSentiment.timeslot);
		const fromDate = new Date(timeslot);
		fromDate.setUTCHours(timeslot.getUTCHours() - 1);
		fromDate.setUTCSeconds(fromDate.getUTCSeconds() + 1);

		/** Retrieve tweets from message manager */
		const memories = await this.runtime
			.getMemories({
				tableName: "messages",
				roomId: this.roomId,
				start: fromDate.getTime(),
				end: timeslot.getTime(),
			});

		// Filter for twitter messages only
		const tweets = memories
			.filter(
				(memory): memory is Memory & { content: TwitterContent } =>
					memory.content.source === "twitter",
			)
			.sort((a, b) => b.createdAt - a.createdAt);

		if (!tweets || tweets.length === 0) {
			logger.info(
				`No tweets to process for timeslot ${timeslot.toISOString()}`,
			);

			// Mark as processed
			const updatedSentiments = sentiments.map((s) =>
				s.timeslot === unprocessedSentiment.timeslot
					? { ...s, processed: true }
					: s,
			);
			await this.runtime
				
				.setCache<Sentiment[]>("sentiments", updatedSentiments);
			return true;
		}

		const tweetArray = tweets.map((memory) => {
			const tweet = memory.content;
			return `username: ${tweet.tweet?.username || "unknown"} tweeted: ${tweet.text}${tweet.tweet?.likes ? ` with ${tweet.tweet.likes} likes` : ""}${tweet.tweet?.retweets ? ` and ${tweet.tweet.retweets} retweets` : ""}.`;
		});

		const bulletpointTweets = makeBulletpointList(tweetArray);
		const prompt = template.replace("{{tweets}}", bulletpointTweets);

		const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
			prompt,
			system: rolePrompt,
			temperature: 0.2,
			maxTokens: 4096,
			object: true,
		});

		// Parse the JSON response
		const json = JSON.parse(response || "{}");

		// Update sentiment with analysis results
		const updatedSentiments = sentiments.map((s) =>
			s.timeslot === unprocessedSentiment.timeslot
				? {
						...s,
						text: json.text,
						occuringTokens: json.occuringTokens,
						processed: true,
					}
				: s,
		);
		await this.runtime
			
			.setCache<Sentiment[]>("sentiments", updatedSentiments);

		logger.info(
			`Successfully processed timeslot ${new Date(unprocessedSentiment.timeslot).toISOString()}`,
		);
		return true;
	}
}
