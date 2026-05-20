export type NotifyGroupChatInviteFn = (
  userId: string,
  npcId: string,
  groupId: string,
  chatName: string,
  inviteId: string
) => Promise<void>;

let notifyFn: NotifyGroupChatInviteFn | null = null;

export function setNotifyGroupChatInvite(
  fn: NotifyGroupChatInviteFn | null
): void {
  notifyFn = fn;
}

export async function notifyGroupChatInvite(
  userId: string,
  npcId: string,
  groupId: string,
  chatName: string,
  inviteId: string
): Promise<void> {
  if (!notifyFn) return;
  await notifyFn(userId, npcId, groupId, chatName, inviteId);
}
