// TODO: add isConnectedTo field or similar which you will use to connect w other KAs
export const dkgMemoryTemplate = {
    "@context": "http://schema.org",
    "@type": "SocialMediaPosting",
    headline: "<describe memory in a short way, as a title here>",
    articleBody:
        "Check out this amazing project on decentralized cloud networks! @DecentralCloud #Blockchain #Web3",
    author: {
        "@type": "Person",
        "@id": "uuid:john:doe",
        name: "John Doe",
        identifier: "@JohnDoe",
        url: "https://twitter.com/JohnDoe",
    },
    dateCreated: "yyyy-mm-ddTHH:mm:ssZ",
    interactionStatistic: [
        {
            "@type": "InteractionCounter",
            interactionType: {
                "@type": "LikeAction",
            },
            userInteractionCount: 150,
        },
        {
            "@type": "InteractionCounter",
            interactionType: {
                "@type": "ShareAction",
            },
            userInteractionCount: 45,
        },
    ],
    mentions: [
        {
            "@type": "Person",
            name: "Twitter account mentioned name goes here",
            identifier: "@TwitterAccount",
            url: "https://twitter.com/TwitterAccount",
        },
    ],
    keywords: [
        {
            "@type": "Text",
            "@id": "uuid:keyword1",
            name: "keyword1",
        },
        {
            "@type": "Text",
            "@id": "uuid:keyword2",
            name: "keyword2",
        },
    ],
    about: [
        {
            "@type": "Thing",
            "@id": "uuid:thing1",
            name: "Blockchain",
            url: "https://en.wikipedia.org/wiki/Blockchain",
        },
        {
            "@type": "Thing",
            "@id": "uuid:thing2",
            name: "Web3",
            url: "https://en.wikipedia.org/wiki/Web3",
        },
        {
            "@type": "Thing",
            "@id": "uuid:thing3",
            name: "Decentralized Cloud",
            url: "https://example.com/DecentralizedCloud",
        },
    ],
    url: "https://twitter.com/JohnDoe/status/1234567890",
};

export const combinedSparqlExample = `
SELECT DISTINCT ?headline ?articleBody
    WHERE {
      ?s a <http://schema.org/SocialMediaPosting> .
      ?s <http://schema.org/headline> ?headline .
      ?s <http://schema.org/articleBody> ?articleBody .

      OPTIONAL {
        ?s <http://schema.org/keywords> ?keyword .
        ?keyword <http://schema.org/name> ?keywordName .
      }

      OPTIONAL {
        ?s <http://schema.org/about> ?about .
        ?about <http://schema.org/name> ?aboutName .
      }

      FILTER(
        CONTAINS(LCASE(?headline), "example_keyword") ||
        (BOUND(?keywordName) && CONTAINS(LCASE(?keywordName), "example_keyword")) ||
        (BOUND(?aboutName) && CONTAINS(LCASE(?aboutName), "example_keyword"))
      )
    }
    LIMIT 10`;

export const sparqlExamples = [
    `
    SELECT DISTINCT ?headline ?articleBody
    WHERE {
      ?s a <http://schema.org/SocialMediaPosting> .
      ?s <http://schema.org/headline> ?headline .
      ?s <http://schema.org/articleBody> ?articleBody .

      OPTIONAL {
        ?s <http://schema.org/keywords> ?keyword .
        ?keyword <http://schema.org/name> ?keywordName .
      }

      OPTIONAL {
        ?s <http://schema.org/about> ?about .
        ?about <http://schema.org/name> ?aboutName .
      }

      FILTER(
        CONTAINS(LCASE(?headline), "example_keyword") ||
        (BOUND(?keywordName) && CONTAINS(LCASE(?keywordName), "example_keyword")) ||
        (BOUND(?aboutName) && CONTAINS(LCASE(?aboutName), "example_keyword"))
      )
    }
    LIMIT 10
    `,
    `
    SELECT DISTINCT ?headline ?articleBody
    WHERE {
      ?s a <http://schema.org/SocialMediaPosting> .
      ?s <http://schema.org/headline> ?headline .
      ?s <http://schema.org/articleBody> ?articleBody .
      FILTER(
        CONTAINS(LCASE(?headline), "example_headline_word1") ||
        CONTAINS(LCASE(?headline), "example_headline_word2")
      )
    }
    `,
    `
    SELECT DISTINCT ?headline ?articleBody ?keywordName
    WHERE {
      ?s a <http://schema.org/SocialMediaPosting> .
      ?s <http://schema.org/headline> ?headline .
      ?s <http://schema.org/articleBody> ?articleBody .
      ?s <http://schema.org/keywords> ?keyword .
      ?keyword <http://schema.org/name> ?keywordName .
      FILTER(
        CONTAINS(LCASE(?keywordName), "example_keyword1") ||
        CONTAINS(LCASE(?keywordName), "example_keyword2")
      )
    }
    `,
    `
    SELECT DISTINCT ?headline ?articleBody ?aboutName
    WHERE {
      ?s a <http://schema.org/SocialMediaPosting> .
      ?s <http://schema.org/headline> ?headline .
      ?s <http://schema.org/articleBody> ?articleBody .
      ?s <http://schema.org/about> ?about .
      ?about <http://schema.org/name> ?aboutName .
      FILTER(
        CONTAINS(LCASE(?aboutName), "example_about1") ||
        CONTAINS(LCASE(?aboutName), "example_about2")
      )
    }
    `,
];

export const generalSparqlQuery = `
    SELECT DISTINCT ?headline ?articleBody
    WHERE {
      ?s a <http://schema.org/SocialMediaPosting> .
      ?s <http://schema.org/headline> ?headline .
      ?s <http://schema.org/articleBody> ?articleBody .
    }
    LIMIT 10
  `;

export const DKG_EXPLORER_LINKS = {
    testnet: "https://dkg-testnet.origintrail.io/explore?ual=",
    mainnet: "https://dkg.origintrail.io/explore?ual=",
};

export function isSentimentAnalysisQueryPrompt(query: string) {
    return `Given the following query, determine if it is related to sentiment analysis of a stock, cryptocurrency, token, or financial asset.
    A query is considered relevant if it involves analyzing emotions, trends, market mood, social media sentiment, news sentiment, or investor confidence regarding a financial asset.

    Example 1 (Yes):
    Query: "What is the current sentiment on Bitcoin based on recent news and social media?"
    Response: "Yes"

    Example 2 (No):
    Query: "What is the market cap of Ethereum?"
    Response: "No"

    Example 3 (Yes):
    Query: "What do you think about $TSLA recently?"
    Response: "Yes"

    Example 4 (No):
    Query: "What's the best way to bake a chocolate cake?"
    Response: "No"

    Input:
    Provided query: ${query}

    Task:
    Return 'Yes' if the provided query is about sentiment analysis in finance, otherwise return 'No'. Make sure to reply only with 'Yes' or 'No', do not give any other comments or remarks.`;
}

function getStartTime48HoursAgo() {
    const now = new Date();
    const past48Hours = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    return past48Hours.toISOString();
}

export function getSentimentAnalysisQuery(topic: string) {
    return `PREFIX schema: <http://schema.org/>

    SELECT ?observation ?score ?impressions ?tweetText
    WHERE {
      BIND('${topic}' AS ?topic)

      ?dataset a schema:Dataset ;
                  schema:about ?topic ;
                  schema:observation ?observation .
      ?observation a schema:Observation ;
                     schema:observationDate ?observationDate ;
                     schema:value ?score ;
                     schema:impressions ?impressions ;
      FILTER (?observationDate >= "${getStartTime48HoursAgo()}")
    }`;
}

export function getRelatedDatasetsQuery(topic: string) {
    return `
    PREFIX schema: <http://schema.org/>

  SELECT ?dataset ?ual ?dateCreated
    WHERE {

      ?dataset a schema:Dataset .
      GRAPH ?ual {
            ?dataset schema:about '${topic}' .
            ?dataset schema:dateCreated ?dateCreated
      }
    }`;
}

export function extractSentimentAnalysisTopic(post: string) {
    return `You are an AI assistant that extracts the main financial topic from a given social media post. Your task is to identify and return only a **stock ticker (cashtag, e.g., $AAPL, $BTC), a hashtag (e.g., #Ethereum, #SP500), a financial asset name (e.g., Bitcoin, Nvidia, Tesla), or an index (e.g., S&P 500, Nasdaq 100)** mentioned in the post.

### **Instructions:**
1. **Extract only one relevant financial entity** (cashtag, hashtag, company name, cryptocurrency, stock, or index).
2. **Do not include** general words, opinions, news sources, or irrelevant content.
3. **Do not modify the extracted entity**. Preserve its exact format as in the post (e.g., "$TSLA", "#Bitcoin", "Ethereum").

### **Example Inputs & Outputs:**

**Input:**
"The market is crazy today! $BTC is pumping, what's your opinion on the sentiment?"
**Output:**
"$BTC"

**Input:**
"Ethereum is gaining momentum, what do you think about it?"
**Output:**
"Ethereum"

**Input:**
"Is Nvidia ($NVDA) still a good buy after the earnings call?"
**Output:**
"$NVDA"

**Input:**
"Tech stocks are looking strong this quarter!"
**Output:**
"None"

**Input:**
"Is Tesla the most shorted stock right now?."
**Output:**
"Tesla"

** Actual input: ${post} **

Return the main financial topic which is to be extracted. Make sure to return only the financial topic and no other comments or remarks.
`;
}
