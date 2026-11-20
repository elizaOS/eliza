// A quote post goes out as a thread (plugins/plugin-x/src/utils.ts
// sendTextAsTweetThread and splitTweetContent). Its first post goes through
// createQuoteTweetRequest (src/client/tweets.ts), which appends
// " https://twitter.com/i/status/<id>": quote_tweet_id needs an X Enterprise
// plan, so the status URL is what makes the post a quote. X counts any URL as
// 23 weighted characters, so the link costs 24 with its space, and X refuses a
// post over 280 weighted characters. The later posts are plain replies to the
// previous post. The timeline, interactions, discovery and connector quote
// paths split with quoteThreadFirstChunkMaxLength, so the first post keeps
// room for the link.
// One case: one quote of `quoteLength` weighted characters without whitespace
// or URLs, so each post is cut at its limit.
module XQuoteThread {
  pure val Limit = 280
  pure val Link = 24
  // One post, the first-post edge (256 and 257), the 257-280 range that X
  // refused before, one character over the limit, and longer threads.
  pure val Lengths = Set(1, 200, 256, 257, 269, 280, 281, 536, 537, 600)
  pure val MaxPosts = 3

  // Weighted length of the quote text.
  var quoteLength: int
  // Weighted characters of the quote text that are not posted yet.
  var remaining: int
  // Weighted length of each post that X received, in order. The first post
  // includes the link.
  var posts: List[int]
  // X refused the last post, so the thread stopped.
  var refused: bool

  action init = all {
    nondet chosen = Lengths.oneOf()
    all {
      quoteLength' = chosen,
      remaining' = chosen,
      posts' = List(),
      refused' = false,
    },
  }

  // Text budget of the post at `index`: the first post keeps room for the link.
  pure def postLimit(index: int): int = if (index == 0) Limit - Link else Limit
  pure def smaller(a: int, b: int): int = if (a < b) a else b
  pure def chunkAt(left: int, index: int): int = smaller(left, postLimit(index))
  // Weighted length that X receives for the post at `index`.
  pure def sentAt(left: int, index: int): int =
    chunkAt(left, index) + (if (index == 0) Link else 0)
  pure def total(lengths: List[int]): int =
    lengths.foldl(0, (sum, n) => sum + n)

  val Finished = remaining == 0 or refused

  // Send the next post of the thread; X refuses it when it is over the limit.
  action post = all {
    not(Finished),
    quoteLength' = quoteLength,
    remaining' = remaining - chunkAt(remaining, posts.length()),
    posts' = posts.append(sentAt(remaining, posts.length())),
    refused' = sentAt(remaining, posts.length()) > Limit,
  }
  // The next post has not been sent yet.
  action stutter = all {
    quoteLength' = quoteLength,
    remaining' = remaining,
    posts' = posts,
    refused' = refused,
  }
  action step = any { post, stutter }

  val ModelState = {
    quoteLength: quoteLength,
    remaining: remaining,
    posts: posts,
    refused: refused,
  }
  temporal ReplayEndsWithoutFairness = eventually(Finished)
  temporal ReplayEnds = post.weakFair(ModelState)
    .implies(ReplayEndsWithoutFairness)

  // X accepts every post of a quote thread.
  val NoRefusal = not(refused)
  // Every post, the first one with its link, is within X's limit.
  val EveryPostFits = posts.foldl(true, (ok, n) => ok and n <= Limit)
  // Each post carries text; the first one carries the link besides.
  val NoEmptyPost =
    posts.indices().forall(i => posts[i] > (if (i == 0) Link else 0))
  // The posts carry the quote text in order and drop none of it.
  val TextKept =
    total(posts) - (if (posts.length() > 0) Link else 0) + remaining
      == quoteLength
  // A finished thread has as few posts as the text and the link need.
  val FewestPosts = or {
    remaining != 0,
    posts.length() == (quoteLength + Link + Limit - 1) / Limit,
  }
  val TypeOK = and {
    Lengths.contains(quoteLength),
    remaining.in(0.to(quoteLength)),
    posts.length() <= MaxPosts,
  }
}
