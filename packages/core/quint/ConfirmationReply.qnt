// requireConfirmation (packages/core/src/utils/confirmation.ts) holds a
// destructive action until the user answers its prompt. A reply with a no
// word anywhere cancels it. A reply that opens with a yes and has no no word
// confirms it. Any other reply leaves it pending, and the prompt is asked
// again.
// language: 0 English, 1 Spanish, 2 French, 3 German, 4 Korean, which put a
// space between words; 5 Chinese and 6 Japanese, which do not.
// A reply is a list of one to three words: 0 the language's yes word
// (yes, sí, oui, ja, 확인, 确认, はい), 1 its no word for "not" (not, no,
// pas, nicht, 아니요, 不要, いいえ), 2 an ordinary word (now). A comma
// follows the first word; in Chinese and Japanese the other words run
// together with no space ("确认，现在不要").
// status: 0 pending, 1 confirmed, 2 cancelled.
module ConfirmationReply {
  pure val Languages = 0.to(6)
  pure val Words = 0.to(2)
  var language: int
  var reply: List[int]
  var status: int

  pure def has(list: List[int], value: int): bool =
    list.indices().exists(i => list[i] == value)
  pure def words(count: int, first: int, second: int, third: int): List[int] =
    [first, second, third].slice(0, count)
  pure def decide(r: List[int]): int =
    if (has(r, 1)) 2
    else if (r[0] == 0) 1
    else 0
  // A reply that settles the prompt: it has a no word or opens with a yes.
  pure def clear(r: List[int]): bool = has(r, 1) or r[0] == 0

  action init = {
    nondet chosen = Languages.oneOf()
    all { language' = chosen, reply' = [], status' = 0 }
  }
  action answer(settles: bool): bool = {
    nondet count = 1.to(3).oneOf()
    nondet first = Words.oneOf()
    nondet second = Words.oneOf()
    nondet third = Words.oneOf()
    val r = words(count, first, second, third)
    all {
      status == 0,
      clear(r) == settles,
      language' = language, reply' = r, status' = decide(r)
    }
  }
  // The user may not answer, or may keep answering unclearly.
  action stutter = all {
    language' = language, reply' = reply, status' = status
  }
  action step = any { answer(true), answer(false), stutter }

  val ModelState = { language: language, reply: reply, status: status }
  temporal ReplySettlesWithoutFairness = (status == 0).leadsTo(status != 0)
  temporal ReplySettles = answer(true).weakFair(ModelState)
    .implies(ReplySettlesWithoutFairness)

  val NoWordCancels = reply.length() == 0 or not(has(reply, 1)) or status == 2
  val NoWordNeverConfirms = status != 1 or not(has(reply, 1))
  val PlainYesConfirms =
    reply.length() == 0 or has(reply, 1) or reply[0] != 0 or status == 1
  val UnclearReplyAsksAgain =
    reply.length() == 0 or clear(reply) or status == 0
  val TypeOK =
    Languages.contains(language) and Set(0, 1, 2).contains(status) and
    reply.length() <= 3 and reply.indices().forall(i => Words.contains(reply[i])) and
    (reply.length() == 0 implies status == 0)
}
