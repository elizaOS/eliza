//@ backend dafny
// spec/agent/voice/session.md, "Filler, sound annotations and the assistant's own echo are never a turn"
import { type HeardTurn, echoOverlapPercent, isEcho, turnAccepted } from "../../gen/agent__voice__session.ts";

export interface ReplyWindow { agentSpeaking: boolean; startKnown: boolean; startedAfterReplyEndMs: number; replyAgeMs: number; echoCancelled: boolean }

export function overlapCount(words: string[], reply: string[]): number {
  //@ ensures 0 <= \result && \result <= words.length
  //@ ensures exists(matched, (\result == 0 <==> matched in [new Set<number>()]) && \result == matched.size && forall(j, (j in matched) <==> (0 <= j && j < words.length && words[j] in reply)))
  let count = 0;
  let i = 0;
  //@ ghost let matched: Set<number> = new Set<number>()
  while (i < words.length) {
    //@ invariant 0 <= i && i <= words.length
    //@ invariant 0 <= count && count <= i
    //@ invariant count == matched.size
    //@ invariant forall(j, (j in matched) <==> (0 <= j && j < i && words[j] in reply))
    if (reply.includes(words[i])) count = count + 1;
    //@ ghost matched = words[i] in reply ? matched.add(i) : matched
    i = i + 1;
  }
  //@ assert count == 0 <==> matched in [new Set<number>()]
  return count;
}

//@ pure
export function overlapPercent(count: number, words: number): number {
  //@ requires 0 <= count && count <= words
  //@ ensures 0 <= \result && \result <= 100
  //@ ensures words > 0 ==> ((\result >= echoOverlapPercent) === (count * 100 >= echoOverlapPercent * words))
  return words === 0 ? 0 : Math.floor((count * 100) / words);
}

export function heardTurn(words: string[], onlyFiller: boolean, reply: string[], replyWindow: ReplyWindow): HeardTurn {
  //@ ensures \result.words === words.length
  //@ ensures 0 <= \result.overlapPercent && \result.overlapPercent <= 100
  //@ ensures words.length === 1 ==> !isEcho(\result)
  //@ ensures (words.length === 1 && !onlyFiller) ==> turnAccepted(\result)
  //@ ensures (words.length === 0 || onlyFiller) ==> !turnAccepted(\result)
  //@ ensures \result.overlapPercent < echoOverlapPercent ==> !isEcho(\result)
  const count = overlapCount(words, reply);
  return {
    words: words.length, onlyFiller: onlyFiller, overlapPercent: overlapPercent(count, words.length),
    agentSpeaking: replyWindow.agentSpeaking, startKnown: replyWindow.startKnown,
    startedAfterReplyEndMs: replyWindow.startedAfterReplyEndMs, replyAgeMs: replyWindow.replyAgeMs, echoCancelled: replyWindow.echoCancelled,
  };
}
