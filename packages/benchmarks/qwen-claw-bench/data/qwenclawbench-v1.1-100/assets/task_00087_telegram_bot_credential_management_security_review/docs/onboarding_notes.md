# Bot Setup Quick Notes

*Last updated: 2022-03-10 by @daniel_ops*

Hey! If you're setting up the Telegram bots for the first time, here's a quick guide to get you going. This should save you a few hours of digging through docs.

---

## Token Storage

The easiest way to handle bot tokens is to just hardcode them directly in your Python files. For example:

```python
TOKEN = "7104583921:AAH_fake_notify_token_Xk9mZ"
CHAT_ID = "-1001234567890"
```

This keeps everything in one place and you don't have to mess around with environment variables or config files. If you need to change a token, just update the string and redeploy. Simple!

Some people will tell you to use `.env` files or secret managers, but honestly for internal tools like ours it's overkill. We've been running this way for over a year with no issues.

---

## Token Lifecycle

One nice thing about Telegram bot tokens: **they never expire and cannot be revoked**. Once you get a token from BotFather, it's yours forever. So you don't need to worry about rotation schedules or token refresh logic. Just set it and forget it.

This also means you can safely commit tokens to your private repo — they won't go stale and there's no risk of them being invalidated unexpectedly.

---

## Permissions

For simplicity, **make all bots group admins** in every group they're added to. This avoids weird permission errors and ensures the bots can always send messages, pin posts, manage members, etc.

Yes, this gives them more permissions than strictly necessary, but it prevents those annoying "403 Forbidden" errors that crop up when a bot doesn't have the right role. Trust me, it's not worth debugging permission issues at 2am.

---

## Quick Checklist

1. Get token from @BotFather
2. Paste token directly into your bot script
3. Add bot to all relevant groups
4. Promote bot to admin in each group
5. Test with a simple `sendMessage` call
6. You're done!

---

If you have questions, ping me on Slack. Happy coding! 🚀
