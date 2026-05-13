# Polymarket BTC 15min Check

The monitoring cron fired. Here's what I need:

1. **Run the monitor** — Check if there are any new resolved BTC 15-minute rounds since the last reported one. The last state is in `.openclaw/data/pm_btc15m_last_reported.txt`. Use the mock HTML data in `data/polymarket_btc15m_mock.html` since the live Polymarket site may be inaccessible. Identify **all** new resolved rounds, not just the most recent one.

2. **Script audit** — There's a monitoring script at `scripts/pm_btc15m_monitor.sh`. Read it carefully. Does it have any issues that would prevent it from working correctly in this workspace environment?

3. **Round gap analysis** — Compare the round numbers in the mock data to the last reported round. Are there gaps in the sequence? What do those gaps tell us about the monitoring history and how many rounds were missed?

4. **Write the result** — Save the latest new resolved round to `.openclaw/data/pm_btc15m_result.txt` in the same pipe-delimited format as the state file. Also update `.openclaw/data/pm_btc15m_last_reported.txt` to reflect the latest round.

5. **Create the skill** — Write a reusable skill at `workspace/skills/polymarket-btc15m-monitor/SKILL.md` documenting this monitoring workflow: state file format, HTML parsing logic, new-round comparison, round gap detection, script requirements, and output format.

Thanks
