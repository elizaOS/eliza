// Mail rules that a native host shares with Cloud's inbox review.

/** Gmail labels reduced to the mailbox state that a reviewed change names:
 * Gmail's historyId, and whether the message is unread, in the inbox or in
 * the trash. No other label leaves this function. */
export const mailboxState = (labels, historyId) => {
  const names = Array.isArray(labels)
    ? labels.filter((label) => typeof label === "string")
    : [];
  return {
    historyId:
      typeof historyId === "string" && /^[0-9]{1,40}$/.test(historyId)
        ? historyId
        : null,
    unread: names.includes("UNREAD"),
    inInbox: names.includes("INBOX"),
    inTrash: names.includes("TRASH"),
  };
};

/** One bare address (no display name), by the rule of Cloud's inbox review
 * (inbox-provider.ts mailbox()). */
export const mailAddress = (value) =>
  typeof value === "string" &&
  value.length <= 254 &&
  !value.includes("..") &&
  /^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(
    value,
  );

/** A recipient list by the rule of inbox-provider.ts addresses(): at most 50
 * addresses, at least one when required. Returns the list, or null. */
export const mailAddresses = (value, required = false) =>
  value === undefined && !required
    ? []
    : Array.isArray(value) &&
        value.length <= 50 &&
        (!required || value.length > 0) &&
        value.every(mailAddress)
      ? value
      : null;
