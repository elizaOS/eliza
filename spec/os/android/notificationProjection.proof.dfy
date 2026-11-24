// Appending a notice adds one to the unread count exactly when that notice is unread.
lemma NpCountAppend(xs: seq<MailNotice>, last: MailNotice)
  ensures unreadMailCount(xs + [last]) == unreadMailCount(xs) + (if mailNoticeUnread(last) then 1 else 0)
{
  forall f: (int, MailNotice) -> int, init: int
    ensures Std.Collections.Seq.FoldLeft(f, init, xs + [last]) == f(Std.Collections.Seq.FoldLeft(f, init, xs), last)
  {
    ProofLib.FoldLeftAppend(f, init, xs, last);
  }
}

lemma lawCappingAShownNoticeKeepsTheCount_ensures(mail: MailNotice, notices: seq<MailNotice>)
  ensures (lawCappingAShownNoticeKeepsTheCount(mail, notices) == true)
{
  NpCountAppend(notices, cappedMail);
  NpCountAppend(notices, mail);
}

lemma lawReadOrDeletedMailIsNeverCounted_ensures(notices: seq<MailNotice>)
  ensures (lawReadOrDeletedMailIsNeverCounted(notices) == true)
{
  NpCountAppend(notices, readOrDeletedMail);
}

lemma lawTheNewNoticeCountsItself_ensures(notices: seq<MailNotice>)
  ensures (lawTheNewNoticeCountsItself(notices) == true)
{
  NpCountAppend(notices, MailNotice(MailNoticePhase.MailPending, false));
}
