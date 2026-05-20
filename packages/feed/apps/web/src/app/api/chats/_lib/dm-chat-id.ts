export function getOtherDmParticipantId(
  chatId: string,
  currentUserId: string
): string | null {
  if (!chatId.startsWith('dm-')) {
    return null;
  }

  const prefix = `dm-${currentUserId}-`;
  if (chatId.startsWith(prefix)) {
    const otherUserId = chatId.slice(prefix.length);
    return otherUserId && otherUserId !== currentUserId ? otherUserId : null;
  }

  const suffix = `-${currentUserId}`;
  if (chatId.endsWith(suffix)) {
    const otherUserId = chatId.slice('dm-'.length, -suffix.length);
    return otherUserId && otherUserId !== currentUserId ? otherUserId : null;
  }

  return null;
}

export function isUserInDmChatId(chatId: string, userId: string): boolean {
  return getOtherDmParticipantId(chatId, userId) !== null;
}
