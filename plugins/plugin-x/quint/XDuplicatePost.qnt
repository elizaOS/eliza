// The autonomous post loop (plugins/plugin-x/src/post.ts
// TwitterPostClient.generateNewTweet) hands each generated post to the
// callback of src/utils/twitter-post-callback.ts. The callback skips the post
// when isDuplicateTweet (src/utils/memory.ts) finds that it repeats one of the
// agent's recent posts; otherwise it posts it and puts it first in the recent
// posts. A post repeats a recent post when its text is the same, or when both
// have words after normalization (lower case; links and every character but
// letters, digits, # and @ dropped) and the words are the same, the words of
// one post appear in the other word for word, in order and next to each
// other, or the two sets of words overlap by at least 90% (Jaccard).
// One case: the agent writes Steps posts in turn, each one of the six posts
// below, starting with no recent posts.
module XDuplicatePost {
  // Normalized words of each post. The texts are in
  // src/duplicate-post-words.test.ts: "GM ☀️", "gm frens",
  // "Paradigm shift ahead.", "Ahead: shift, paradigm!", "wagmi" and "☀️".
  pure val Words: str -> List[str] = Map(
    "gm" -> ["gm"],
    "gmFrens" -> ["gm", "frens"],
    "paradigm" -> ["paradigm", "shift", "ahead"],
    "shiftParadigm" -> ["ahead", "shift", "paradigm"],
    "wagmi" -> ["wagmi"],
    "sun" -> List(),
  )
  pure val Posts = Words.keys()
  pure val Steps = 3
  // isDuplicateTweet reads the ten most recent posts; three steps never fill
  // that window, so no recent post drops out of it.
  pure val MaxRecent = 10

  // Posts the agent wrote, in order.
  var generated: List[str]
  // Whether the callback posted each written post.
  var posted: List[bool]
  // Posts that X received, in order.
  var sent: List[str]
  // The recent posts, newest first.
  var recent: List[str]

  action init = all {
    generated' = List(),
    posted' = List(),
    sent' = List(),
    recent' = List(),
  }

  // `part` appears in `whole` word for word, in order and next to each other.
  pure def containsWords(whole: List[str], part: List[str]): bool =
    0.to(whole.length() - part.length()).exists(start =>
      part.indices().forall(i => whole[start + i] == part[i]))
  pure def wordSet(words: List[str]): Set[str] = words.indices().map(i => words[i])
  // At least 90% of the words of both posts are shared.
  pure def similar(a: List[str], b: List[str]): bool =
    10 * wordSet(a).intersect(wordSet(b)).size()
      >= 9 * wordSet(a).union(wordSet(b)).size()
  pure def repeats(post: str, earlier: str): bool = or {
    post == earlier,
    and {
      Words.get(post).length() > 0,
      Words.get(earlier).length() > 0,
      or {
        Words.get(post) == Words.get(earlier),
        containsWords(Words.get(post), Words.get(earlier)),
        containsWords(Words.get(earlier), Words.get(post)),
        similar(Words.get(post), Words.get(earlier)),
      },
    },
  }
  pure def isDuplicate(post: str, recentPosts: List[str]): bool =
    recentPosts.indices().exists(i => repeats(post, recentPosts[i]))

  val Finished = generated.length() == Steps

  // The agent writes the next post; the callback posts it unless it repeats a
  // recent post.
  action write = {
    nondet post = Posts.oneOf()
    all {
      not(Finished),
      generated' = generated.append(post),
      posted' = posted.append(not(isDuplicate(post, recent))),
      sent' = if (isDuplicate(post, recent)) sent else sent.append(post),
      recent' = if (isDuplicate(post, recent)) recent
        else List(post).concat(recent),
    }
  }
  // The next post has not been written yet.
  action stutter = all {
    generated' = generated,
    posted' = posted,
    sent' = sent,
    recent' = recent,
  }
  action step = any { write, stutter }

  val ModelState = {
    generated: generated,
    posted: posted,
    sent: sent,
    recent: recent,
  }
  temporal ReplayEndsWithoutFairness = eventually(Finished)
  temporal ReplayEnds = write.weakFair(ModelState)
    .implies(ReplayEndsWithoutFairness)

  // A skipped post repeats a post that was sent before it.
  val SkipsOnlyRepeats = generated.indices().forall(i => or {
    posted[i],
    0.to(i - 1).exists(j => posted[j] and repeats(generated[i], generated[j])),
  })
  // A sent post repeats none of the posts sent before it.
  val SentRepeatsNone = generated.indices().forall(i => or {
    not(posted[i]),
    0.to(i - 1).forall(j => not(posted[j]) or not(repeats(generated[i], generated[j]))),
  })
  // X received exactly the posted posts, in the order they were written.
  val SentInOrder = sent == range(0, generated.length()).foldl(List(), (acc, i) =>
    if (posted[i]) acc.append(generated[i]) else acc)
  // The recent posts are the sent posts, newest first.
  val RecentNewestFirst = and {
    recent.length() == sent.length(),
    recent.indices().forall(i => recent[i] == sent[sent.length() - 1 - i]),
  }
  val TypeOK = and {
    generated.length() <= Steps,
    posted.length() == generated.length(),
    recent.length() <= MaxRecent,
    generated.indices().forall(i => Posts.contains(generated[i])),
  }
}
