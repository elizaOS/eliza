/**
 * Corpus-to-Gmail-mock adapter: turns validated `CorpusMessage` shards into
 * the `corpusGmailFixtures`/`corpusGmailFixtureSets` inputs of
 * `createGoogleMockState`, closing the collector → schema → scrub → verify →
 * loader → scenario path for the personal-corpus program (#14747).
 *
 * Only `verified`-scrub rows are accepted — the loader's scrub floor is not
 * loosened here, so raw or partially scrubbed corpus data can never seed a
 * mock server. Absolute corpus timestamps become offsets relative to the
 * corpus anchor so age-sensitive scenarios stay deterministic at run time,
 * and fixture-set names (`corpus-gmail`, `corpus-gmail:<accountId>`) are
 * published through the existing `/__mock/google/gmail/fixtures` manifest.
 */
import {
  CORPUS_ANCHOR_MS,
  type CorpusMessage,
  loadCorpusMessages,
} from "@elizaos/corpus-tools";
import {
  GMAIL_MOCK_ACCOUNT_IDS,
  type GmailFixtureMessage,
  type GoogleMockStateOptions,
} from "./google-gmail-state.ts";

export const CORPUS_GMAIL_FIXTURE_SET = "corpus-gmail";

function emailAddressFor(id: string, address?: string): string {
  if (address) return address;
  return id.includes("@") ? id : `${id}@corpus.invalid`;
}

function formatParty(display: string | undefined, address: string): string {
  return display ? `${display} <${address}>` : address;
}

function corpusMessageToGmailFixture(
  message: CorpusMessage,
): GmailFixtureMessage {
  const senderAddress = emailAddressFor(message.senderId);
  const toValue = message.recipients
    .map((recipient) =>
      formatParty(
        recipient.display,
        emailAddressFor(recipient.id, recipient.address),
      ),
    )
    .join(", ");
  const labelIds =
    message.labels.length > 0
      ? [...message.labels]
      : [message.direction === "out" ? "SENT" : "INBOX"];
  return {
    id: message.id,
    threadId: message.threadId,
    accountId: message.accountId,
    labelIds,
    snippet: message.snippet ?? message.text.slice(0, 120),
    internalDateOffsetMs: message.ts - CORPUS_ANCHOR_MS,
    headers: [
      {
        name: "From",
        value: formatParty(message.senderDisplay, senderAddress),
      },
      { name: "To", value: toValue },
      { name: "Subject", value: message.subject ?? "" },
      { name: "Message-Id", value: `<${message.id}@corpus.invalid>` },
    ],
    bodyText: message.text,
    ...(message.attachments.length > 0
      ? {
          attachments: message.attachments.flatMap((attachment) =>
            attachment.dataBase64
              ? [
                  {
                    attachmentId: `${message.id}-${attachment.sha256}`,
                    filename: attachment.filename,
                    mimeType: attachment.mimeType,
                    data: attachment.dataBase64,
                  },
                ]
              : [],
          ),
        }
      : {}),
  };
}

/**
 * Maps already-loaded gmail-platform corpus rows into Google mock state
 * options. Non-gmail rows are rejected rather than silently dropped: cross
 * channel corpus rows belong to their own mock adapters, and passing them
 * here indicates a caller selection bug. A corpus accountId the mock cannot
 * host is rejected for the same reason — the mock would file those messages
 * under its default account while a `corpus-gmail:<accountId>` fixture set
 * still advertised them under the corpus name.
 */
export function corpusGmailMockOptions(
  messages: readonly CorpusMessage[],
): Pick<
  GoogleMockStateOptions,
  "corpusGmailFixtures" | "corpusGmailFixtureSets"
> {
  const nonGmail = messages.filter((message) => message.platform !== "gmail");
  if (nonGmail.length > 0) {
    throw new Error(
      `corpusGmailMockOptions received ${nonGmail.length} non-gmail row(s); select platform "gmail" before mapping`,
    );
  }

  const unmappable = [
    ...new Set(
      messages
        .map((message) => message.accountId)
        .filter((accountId) => !GMAIL_MOCK_ACCOUNT_IDS.includes(accountId)),
    ),
  ];
  if (unmappable.length > 0) {
    throw new Error(
      `corpusGmailMockOptions received corpus account(s) ${unmappable.join(", ")} the Gmail mock cannot host; supported accounts are ${GMAIL_MOCK_ACCOUNT_IDS.join(", ")}`,
    );
  }

  const fixtures = messages.map(corpusMessageToGmailFixture);
  const fixtureSets: Record<string, string[]> = {
    [CORPUS_GMAIL_FIXTURE_SET]: messages.map((message) => message.id),
  };
  for (const message of messages) {
    const key = `${CORPUS_GMAIL_FIXTURE_SET}:${message.accountId}`;
    const bucket = fixtureSets[key] ?? [];
    bucket.push(message.id);
    fixtureSets[key] = bucket;
  }
  return {
    corpusGmailFixtures: fixtures,
    corpusGmailFixtureSets: fixtureSets,
  };
}

/**
 * Loads verified gmail rows from a corpus shard tree and maps them to Google
 * mock state options. Throws when the corpus fails validation or contains no
 * verified gmail rows — an empty corpus seed is a configuration error, not a
 * quietly fixture-only run.
 */
export async function loadCorpusGmailMockOptions(
  corpusDir: string,
): Promise<
  Pick<GoogleMockStateOptions, "corpusGmailFixtures" | "corpusGmailFixtureSets">
> {
  const result = await loadCorpusMessages(corpusDir, {
    platforms: ["gmail"],
  });
  if (result.messages.length === 0) {
    throw new Error(
      `corpus at ${corpusDir} contains no verified gmail rows (scanned ${result.scanned}, below scrub floor ${result.belowScrubFloor})`,
    );
  }
  return corpusGmailMockOptions(result.messages);
}
