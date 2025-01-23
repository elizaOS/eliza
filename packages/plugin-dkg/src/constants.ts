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
